import { nanoid } from "nanoid";
import type { Store } from "../storage/store";
import type { LLMClient } from "../llm/types";
import type { Meeting, Message, Vote } from "../domain/models";
import type { AgentConfig, MeetingConfig } from "../domain/config";
import type { VoteSession } from "../voting/types";
import type { FacilitatorOutput } from "../facilitator/types";
import type { SseEventToAppend } from "../sse/events";
import { FacilitatorService } from "../facilitator/facilitator";
import { aggregateVotes, evaluateThreshold } from "../voting/evaluator";
import {
  buildAgentPrompt,
  buildVotePrompt,
  selectReplyTargets,
  resolveDiscussionMode,
} from "./context-builder";

export type RunnerCallbacks = {
  onEvent?: (event: SseEventToAppend) => void;
};

export class MeetingRunner {
  private abortController: AbortController | null = null;
  private voteAbortController: AbortController | null = null;

  constructor(
    private store: Store,
    private llmClient: LLMClient,
    private callbacks?: RunnerCallbacks
  ) {}

  async start(meetingId: string): Promise<void> {
    this.abortController = new AbortController();

    await this.store.withMeetingLock(meetingId, async () => {
      const meeting = await this.store.getMeeting(meetingId);
      if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
      if (meeting.state !== "DRAFT") throw new Error(`Meeting not in DRAFT state: ${meeting.state}`);

      const mode = resolveDiscussionMode(meeting.config);
      await this.store.updateMeeting(meetingId, {
        state: "RUNNING_DISCUSSION",
        stage_version: meeting.stage_version + 1,
        effective_discussion_mode: mode,
      });
      this.emitEvent(meetingId, "meeting.state_changed", {
        state: "RUNNING_DISCUSSION",
        round: 0,
        stage_version: meeting.stage_version + 1,
      });
    });

    // Run the meeting loop
    try {
      await this.runLoop(meetingId);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      console.error("[Runner] Error in meeting loop:", err);
      this.emitEvent(meetingId, "error", {
        code: "RUNNER_ERROR",
        message: (err as Error).message,
      });
    }
  }

  async handleUserMessage(meetingId: string, content: string): Promise<Message> {
    return this.store.withMeetingLock(meetingId, async () => {
      const meeting = await this.store.getMeeting(meetingId);
      if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);

      const msg: Message = {
        id: nanoid(),
        meeting_id: meetingId,
        created_at: new Date().toISOString(),
        role: "user",
        content,
        meta: { round: meeting.round, reply_targets: [] },
      };
      await this.store.appendMessage(msg);
      this.emitEvent(meetingId, "message.final", { message: msg });

      // If in voting phase, interrupt
      if (meeting.state === "RUNNING_VOTE") {
        const newVersion = meeting.stage_version + 1;
        await this.store.updateMeeting(meetingId, {
          state: "RUNNING_DISCUSSION",
          stage_version: newVersion,
          active_vote_session_id: undefined,
        });

        // Abort current vote
        this.voteAbortController?.abort();
        this.voteAbortController = null;

        // Finalize active vote session as ABORTED
        if (meeting.active_vote_session_id) {
          await this.store.finalizeVoteSession({
            meeting_id: meetingId,
            vote_session_id: meeting.active_vote_session_id,
            status: "ABORTED",
            ended_at: new Date().toISOString(),
          });
        }

        this.emitEvent(meetingId, "meeting.state_changed", {
          state: "RUNNING_DISCUSSION",
          round: meeting.round,
          stage_version: newVersion,
        });
      }

      return msg;
    });
  }

  stop(): void {
    this.abortController?.abort();
    this.voteAbortController?.abort();
  }

  // ── Main Loop ──

  private async runLoop(meetingId: string): Promise<void> {
    let meeting = await this.store.getMeeting(meetingId);
    if (!meeting) return;

    // Round 0: blind initial responses
    await this.runDiscussionRound(meetingId, 0, true);

    // Main discussion-vote loop
    while (true) {
      meeting = await this.store.getMeeting(meetingId);
      if (!meeting || meeting.state.startsWith("FINISHED")) break;
      if (this.abortController?.signal.aborted) break;

      const round = meeting.round + 1;

      // Check max rounds
      if (round > meeting.config.threshold.max_rounds) {
        await this.finishAborted(meetingId, "Max rounds reached");
        break;
      }

      // Run facilitator if enabled (generates summary for next round)
      if (meeting.config.facilitator.enabled && round > 0) {
        await this.runFacilitator(meetingId, round - 1);
      }

      // Enter voting if min_rounds reached
      if (round >= meeting.config.threshold.min_rounds) {
        const voteResult = await this.runVotingPhase(meetingId, round);
        meeting = await this.store.getMeeting(meetingId);
        if (!meeting || meeting.state.startsWith("FINISHED")) break;

        if (voteResult === "accepted") {
          break;
        }
        // If "rejected" or "aborted", continue discussion
      }

      // Run discussion round
      await this.runDiscussionRound(meetingId, round, false);
    }
  }

  // ── Discussion ──

  private async runDiscussionRound(meetingId: string, round: number, isBlind: boolean): Promise<void> {
    const meeting = await this.store.getMeeting(meetingId);
    if (!meeting || meeting.state !== "RUNNING_DISCUSSION") return;

    await this.store.updateMeeting(meetingId, { round });

    const enabledAgents = meeting.config.agents.filter((a) => a.enabled);
    const { items: allMessages } = await this.store.listMessages({ meeting_id: meetingId });
    const rollingSummary = this.getLatestRollingSummary(allMessages);

    const mode = meeting.effective_discussion_mode ?? "serial_turn";

    if (mode === "parallel_round" || isBlind) {
      await this.runParallelRound(meetingId, meeting, enabledAgents, round, allMessages, rollingSummary, isBlind);
    } else {
      await this.runSerialTurn(meetingId, meeting, enabledAgents, round, allMessages, rollingSummary);
    }
  }

  private async runSerialTurn(
    meetingId: string,
    meeting: Meeting,
    agents: AgentConfig[],
    round: number,
    allMessages: Message[],
    rollingSummary?: string
  ): Promise<void> {
    const userMsgs = allMessages.filter((m) => m.role === "user");

    for (let i = 0; i < agents.length; i++) {
      if (this.abortController?.signal.aborted) return;
      const currentMeeting = await this.store.getMeeting(meetingId);
      if (!currentMeeting || currentMeeting.state !== "RUNNING_DISCUSSION") return;

      const agent = agents[i];
      const { items: freshMessages } = await this.store.listMessages({ meeting_id: meetingId });
      const replyTargets = selectReplyTargets(
        agents, agent.id, freshMessages, meeting.config.discussion.cross_reply_targets_per_agent
      );

      const prompt = buildAgentPrompt({
        topic: meeting.topic,
        rolling_summary: rollingSummary,
        recent_messages: freshMessages.slice(-10),
        agent,
        round,
        reply_targets: replyTargets,
        user_messages_since_last_round: userMsgs.filter(
          (m) => m.meta.round >= round - 1
        ),
      });

      try {
        const resp = await this.llmClient.generateText(
          {
            provider_id: agent.provider,
            model: agent.model,
            messages: prompt,
            temperature: agent.temperature,
            max_tokens: agent.max_output_tokens,
            metadata: { agent_id: agent.id, topic: meeting.topic },
          },
          { signal: this.abortController?.signal }
        );

        const msg: Message = {
          id: nanoid(),
          meeting_id: meetingId,
          created_at: new Date().toISOString(),
          role: "agent",
          agent_id: agent.id,
          content: resp.text,
          meta: {
            round,
            turn_index: i,
            discussion_mode: "serial_turn",
            reply_targets: replyTargets,
            token_usage: resp.usage,
          },
        };
        await this.store.appendMessage(msg);
        this.emitEvent(meetingId, "message.final", { message: msg });
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        console.error(`[Runner] Agent ${agent.id} failed:`, err);
        this.emitEvent(meetingId, "error", {
          code: "AGENT_ERROR",
          message: `Agent ${agent.id} failed: ${(err as Error).message}`,
        });
      }
    }
  }

  private async runParallelRound(
    meetingId: string,
    meeting: Meeting,
    agents: AgentConfig[],
    round: number,
    allMessages: Message[],
    rollingSummary?: string,
    isBlind?: boolean
  ): Promise<void> {
    const userMsgs = allMessages.filter((m) => m.role === "user");
    const stageVersion = meeting.stage_version;

    const tasks = agents.map(async (agent, i) => {
      const replyTargets = isBlind
        ? []
        : selectReplyTargets(agents, agent.id, allMessages, meeting.config.discussion.cross_reply_targets_per_agent);

      const prompt = buildAgentPrompt({
        topic: meeting.topic,
        rolling_summary: rollingSummary,
        recent_messages: isBlind ? [] : allMessages.slice(-10),
        agent,
        round,
        reply_targets: replyTargets,
        user_messages_since_last_round: userMsgs.filter((m) => m.meta.round >= round - 1),
      });

      try {
        const resp = await this.llmClient.generateText(
          {
            provider_id: agent.provider,
            model: agent.model,
            messages: prompt,
            temperature: agent.temperature,
            max_tokens: agent.max_output_tokens,
            metadata: { agent_id: agent.id, topic: meeting.topic },
          },
          { signal: this.abortController?.signal }
        );

        return {
          agent,
          text: resp.text,
          usage: resp.usage,
          turn_index: i,
          reply_targets: replyTargets,
        };
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        console.error(`[Runner] Agent ${agent.id} failed:`, err);
        return null;
      }
    });

    const results = await Promise.allSettled(tasks);

    // Check if stage_version changed (user interrupted)
    const currentMeeting = await this.store.getMeeting(meetingId);
    if (!currentMeeting || currentMeeting.stage_version !== stageVersion) return;

    // Write results in order
    for (const result of results) {
      if (result.status === "rejected") continue;
      const r = result.value;
      if (!r) continue;

      const msg: Message = {
        id: nanoid(),
        meeting_id: meetingId,
        created_at: new Date().toISOString(),
        role: "agent",
        agent_id: r.agent.id,
        content: r.text,
        meta: {
          round,
          turn_index: r.turn_index,
          discussion_mode: "parallel_round",
          reply_targets: r.reply_targets,
          token_usage: r.usage,
        },
      };
      await this.store.appendMessage(msg);
      this.emitEvent(meetingId, "message.final", { message: msg });
    }
  }

  // ── Facilitator ──

  private async runFacilitator(meetingId: string, round: number): Promise<void> {
    const meeting = await this.store.getMeeting(meetingId);
    if (!meeting) return;

    const { items: allMessages } = await this.store.listMessages({ meeting_id: meetingId });
    const recentMessages = allMessages.filter((m) => m.meta.round >= round - 1).slice(-20);
    const rollingSummary = this.getLatestRollingSummary(allMessages);

    const firstEnabledAgent = meeting.config.agents.find((agent) => agent.enabled);
    const facilitator = new FacilitatorService(this.llmClient, {
      ...meeting.config.facilitator,
      provider: meeting.config.facilitator.provider ?? firstEnabledAgent?.provider ?? "mock",
      model: meeting.config.facilitator.model ?? firstEnabledAgent?.model ?? "default",
    });
    const proposal = this.generateProposal(allMessages, meeting.topic);

    try {
      const output = await facilitator.run({
        meeting_id: meetingId,
        topic: meeting.topic,
        round,
        stage_version: meeting.stage_version,
        proposal_text: proposal,
        recent_messages: recentMessages,
        rolling_summary: rollingSummary,
      });

      // Write facilitator message to store
      const msg: Message = {
        id: nanoid(),
        meeting_id: meetingId,
        created_at: new Date().toISOString(),
        role: "system",
        system_id: "facilitator",
        content: this.formatFacilitatorOutput(output),
        meta: { round, reply_targets: [] },
      };
      await this.store.appendMessage(msg);
      this.emitEvent(meetingId, "message.final", { message: msg });
      this.emitEvent(meetingId, "facilitator.output", {
        stage_version: meeting.stage_version,
        round,
        output,
      });
    } catch (err) {
      console.error("[Runner] Facilitator failed:", err);
    }
  }

  // ── Voting ──

  private async runVotingPhase(meetingId: string, round: number): Promise<"accepted" | "rejected" | "aborted"> {
    this.voteAbortController = new AbortController();

    const meeting = await this.store.withMeetingLock(meetingId, async () => {
      const m = await this.store.getMeeting(meetingId);
      if (!m || m.state !== "RUNNING_DISCUSSION") return null;

      const newVersion = m.stage_version + 1;
      await this.store.updateMeeting(meetingId, {
        state: "RUNNING_VOTE",
        stage_version: newVersion,
      });
      this.emitEvent(meetingId, "meeting.state_changed", {
        state: "RUNNING_VOTE",
        round,
        stage_version: newVersion,
      });
      return await this.store.getMeeting(meetingId);
    });

    if (!meeting) return "aborted";

    const enabledAgents = meeting.config.agents.filter((a) => a.enabled);
    const { items: allMessages } = await this.store.listMessages({ meeting_id: meetingId });
    const proposal = this.generateProposal(allMessages, meeting.topic);
    const rollingSummary = this.getLatestRollingSummary(allMessages);

    // Create vote session
    const sessionId = nanoid();
    const session: VoteSession = {
      id: sessionId,
      meeting_id: meetingId,
      round,
      stage_version: meeting.stage_version,
      proposal_text: proposal,
      status: "RUNNING",
      started_at: new Date().toISOString(),
      ended_at: null,
      expected_voter_agent_ids: enabledAgents.map((a) => a.id),
    };
    await this.store.createVoteSession(session);
    await this.store.updateMeeting(meetingId, { active_vote_session_id: sessionId });
    this.emitEvent(meetingId, "vote.session_started", {
      vote_session_id: sessionId,
      stage_version: meeting.stage_version,
    });

    // Concurrent voting
    const voteTasks = enabledAgents.map(async (agent) => {
      const prompt = buildVotePrompt({
        topic: meeting.topic,
        proposal,
        agent,
        rolling_summary: rollingSummary,
      });

      try {
        const resp = await this.llmClient.generateText(
          {
            provider_id: agent.provider,
            model: agent.model,
            messages: prompt,
            temperature: 0.1,
            max_tokens: 500,
            response_format: { type: "json_object" },
            metadata: { agent_id: agent.id, topic: meeting.topic },
          },
          { signal: this.voteAbortController?.signal }
        );

        let parsed: { score: number; pass: boolean; rationale?: string };
        try {
          parsed = JSON.parse(resp.text);
        } catch {
          parsed = { score: 50, pass: false, rationale: "Failed to parse vote response" };
        }

        const vote: Vote = {
          id: nanoid(),
          meeting_id: meetingId,
          vote_session_id: sessionId,
          voter_agent_id: agent.id,
          score: Math.max(0, Math.min(100, Math.round(parsed.score))),
          pass: parsed.pass ?? false,
          rationale: parsed.rationale,
          stage_version: meeting.stage_version,
          created_at: new Date().toISOString(),
        };

        // Validate stage_version before writing
        const currentMeeting = await this.store.getMeeting(meetingId);
        if (!currentMeeting || currentMeeting.stage_version !== meeting.stage_version) {
          return null; // Stale vote
        }

        await this.store.appendVote(vote);
        this.emitEvent(meetingId, "vote.received", { vote });
        return vote;
      } catch (err) {
        if ((err as Error).name === "AbortError") return null;
        console.error(`[Runner] Vote from ${agent.id} failed:`, err);
        return null;
      }
    });

    const results = await Promise.allSettled(voteTasks);

    // Check if vote was aborted
    const currentMeeting = await this.store.getMeeting(meetingId);
    if (!currentMeeting || currentMeeting.stage_version !== meeting.stage_version) {
      return "aborted";
    }

    // Aggregate
    const votes = results
      .filter((r): r is PromiseFulfilledResult<Vote | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is Vote => v !== null);

    const agg = aggregateVotes(votes);
    const evaluation = evaluateThreshold({
      threshold: meeting.config.threshold,
      round,
      aggregation: {
        meeting_id: meetingId,
        vote_session_id: sessionId,
        stage_version: meeting.stage_version,
        ...agg,
      },
    });

    // Finalize session
    await this.store.finalizeVoteSession({
      meeting_id: meetingId,
      vote_session_id: sessionId,
      status: "FINALIZED",
      ended_at: new Date().toISOString(),
    });

    this.emitEvent(meetingId, "vote.session_final", {
      vote_session_id: sessionId,
      stage_version: meeting.stage_version,
      accepted: evaluation.accepted,
      avg_score: evaluation.avg_score,
      reason: evaluation.reason,
    });

    if (evaluation.accepted) {
      await this.finishAccepted(meetingId, agg.avg_score, proposal);
      return "accepted";
    }

    // Back to discussion
    await this.store.withMeetingLock(meetingId, async () => {
      const m = await this.store.getMeeting(meetingId);
      if (m && m.state === "RUNNING_VOTE") {
        await this.store.updateMeeting(meetingId, {
          state: "RUNNING_DISCUSSION",
          stage_version: m.stage_version + 1,
          active_vote_session_id: undefined,
        });
        this.emitEvent(meetingId, "meeting.state_changed", {
          state: "RUNNING_DISCUSSION",
          round,
          stage_version: m.stage_version + 1,
        });
      }
    });

    return "rejected";
  }

  // ── Finish ──

  private async finishAccepted(meetingId: string, avgScore: number, proposal: string): Promise<void> {
    const updated = await this.store.updateMeeting(meetingId, {
      state: "FINISHED_ACCEPTED",
      result: {
        accepted: true,
        concluded_at: new Date().toISOString(),
        summary_markdown: proposal,
        reason: `Consensus reached with average score: ${avgScore}`,
      },
    });
    this.emitEvent(meetingId, "meeting.state_changed", {
      state: "FINISHED_ACCEPTED",
      round: updated.round,
      stage_version: updated.stage_version,
    });
  }

  private async finishAborted(meetingId: string, reason: string): Promise<void> {
    const { items: allMessages } = await this.store.listMessages({ meeting_id: meetingId });
    const proposal = this.generateProposal(allMessages, "");

    const updated = await this.store.updateMeeting(meetingId, {
      state: "FINISHED_ABORTED",
      result: {
        accepted: false,
        concluded_at: new Date().toISOString(),
        summary_markdown: proposal,
        reason,
      },
    });
    this.emitEvent(meetingId, "meeting.state_changed", {
      state: "FINISHED_ABORTED",
      round: updated.round,
      stage_version: updated.stage_version,
    });
  }

  // ── Helpers ──

  private generateProposal(messages: Message[], topic: string): string {
    const agentMessages = messages.filter((m) => m.role === "agent");
    if (agentMessages.length === 0) return `No discussion yet on: ${topic}`;

    const lastRound = Math.max(...agentMessages.map((m) => m.meta.round));
    const lastRoundMsgs = agentMessages.filter((m) => m.meta.round === lastRound);

    let proposal = `## Meeting Conclusion Draft\n\nTopic: ${topic}\n\n### Key Points from Round ${lastRound}:\n\n`;
    for (const m of lastRoundMsgs) {
      proposal += `**${m.agent_id}**: ${m.content.slice(0, 300)}\n\n`;
    }
    return proposal;
  }

  private getLatestRollingSummary(messages: Message[]): string | undefined {
    const facilMsgs = messages.filter((m) => m.system_id === "facilitator");
    return facilMsgs.length > 0 ? facilMsgs[facilMsgs.length - 1].content : undefined;
  }

  private formatFacilitatorOutput(output: FacilitatorOutput): string {
    let content = `## Facilitator Summary\n\n`;
    content += `### Round Summary\n${output.round_summary}\n\n`;
    content += `### Key Disagreements\n`;
    output.disagreements.forEach((d, i) => { content += `${i + 1}. ${d}\n`; });
    content += `\n### Proposed Changes\n${output.proposed_patch}\n\n`;
    content += `### Next Round Focus\n`;
    output.next_focus.forEach((f, i) => { content += `${i + 1}. ${f}\n`; });
    return content;
  }

  private emitEvent(meetingId: string, type: string, payload: Record<string, unknown>): void {
    const event: SseEventToAppend = {
      meeting_id: meetingId,
      at: new Date().toISOString(),
      type: type as SseEventToAppend["type"],
      payload: payload as SseEventToAppend["payload"],
    };
    this.store.appendEvent(event).catch((err) => {
      console.error("[Runner] Failed to append event:", err);
    });
    this.callbacks?.onEvent?.(event);
  }
}
