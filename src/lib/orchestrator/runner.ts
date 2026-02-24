import { nanoid } from "nanoid";
import type { Store } from "../storage/store";
import type {
  LLMChatMessage,
  LLMClient,
  LLMGenerateTextRequest,
  LLMGenerateTextResponse,
} from "../llm/types";
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
import { buildMeetingReportMarkdown } from "./meeting-report";

export type RunnerCallbacks = {
  onEvent?: (event: SseEventToAppend) => void;
};

type FinalDocumentResult = {
  markdown: string;
  attempts: number;
  unanimous: boolean;
  approvals: Vote[];
  avgScore: number;
  note: string;
};

type ResilientGenerateResult = {
  response: LLMGenerateTextResponse;
  provider_id: string;
  model: string;
  used_fallback: boolean;
};

type FinalEditorResult = {
  markdown: string;
  succeeded: boolean;
  attempts: number;
  error?: string;
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

      // Run discussion round first, then vote on this round.
      const addedAgentMessages = await this.runDiscussionRound(meetingId, round, false);
      meeting = await this.store.getMeeting(meetingId);
      if (!meeting || meeting.state.startsWith("FINISHED")) break;

      // Enter voting if min_rounds reached
      if (round >= meeting.config.threshold.min_rounds) {
        if (addedAgentMessages === 0) {
          this.emitEvent(meetingId, "error", {
            code: "DISCUSSION_EMPTY_SKIP_VOTE",
            message: `Round ${round} has no successful agent outputs; voting skipped.`,
          });
          continue;
        }

        const voteResult = await this.runVotingPhase(meetingId, round);
        meeting = await this.store.getMeeting(meetingId);
        if (!meeting || meeting.state.startsWith("FINISHED")) break;

        if (voteResult === "accepted") {
          break;
        }
        // If "rejected" or "aborted", continue next round.
      }
    }
  }

  // ── Discussion ──

  private async runDiscussionRound(meetingId: string, round: number, isBlind: boolean): Promise<number> {
    const meeting = await this.store.getMeeting(meetingId);
    if (!meeting || meeting.state !== "RUNNING_DISCUSSION") return 0;

    await this.store.updateMeeting(meetingId, { round });

    const enabledAgents = meeting.config.agents.filter((a) => a.enabled);
    const { items: allMessages } = await this.store.listMessages({ meeting_id: meetingId });
    const rollingSummary = this.getLatestRollingSummary(allMessages);

    const mode = meeting.effective_discussion_mode ?? "serial_turn";

    if (mode === "parallel_round" || isBlind) {
      return this.runParallelRound(meetingId, meeting, enabledAgents, round, allMessages, rollingSummary, isBlind);
    } else {
      return this.runSerialTurn(meetingId, meeting, enabledAgents, round, allMessages, rollingSummary);
    }
  }

  private async runSerialTurn(
    meetingId: string,
    meeting: Meeting,
    agents: AgentConfig[],
    round: number,
    allMessages: Message[],
    rollingSummary?: string
  ): Promise<number> {
    let appendedCount = 0;
    const userMsgs = allMessages.filter((m) => m.role === "user");

    for (let i = 0; i < agents.length; i++) {
      if (this.abortController?.signal.aborted) return appendedCount;
      const currentMeeting = await this.store.getMeeting(meetingId);
      if (!currentMeeting || currentMeeting.state !== "RUNNING_DISCUSSION") return appendedCount;

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
        const generated = await this.generateTextWithProviderFallback(
          {
            provider_id: agent.provider,
            model: agent.model,
            messages: prompt,
            temperature: agent.temperature,
            max_tokens: agent.max_output_tokens,
            timeout_ms: this.getDiscussionTimeoutMs(meeting),
            metadata: { agent_id: agent.id, topic: meeting.topic },
          },
          { signal: this.abortController?.signal },
          { operation: "discussion", allow_mock_fallback: true }
        );
        const resp = generated.response;

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
            provider_request_id: generated.used_fallback
              ? `fallback:${agent.provider}->${generated.provider_id}`
              : undefined,
          },
        };
        await this.store.appendMessage(msg);
        this.emitEvent(meetingId, "message.final", { message: msg });
        appendedCount += 1;
      } catch (err) {
        if ((err as Error).name === "AbortError") return appendedCount;
        console.error(`[Runner] Agent ${agent.id} failed:`, err);
        this.emitEvent(meetingId, "error", {
          code: "AGENT_ERROR",
          message: `Agent ${agent.id} failed: ${(err as Error).message}`,
        });
      }
    }

    return appendedCount;
  }

  private async runParallelRound(
    meetingId: string,
    meeting: Meeting,
    agents: AgentConfig[],
    round: number,
    allMessages: Message[],
    rollingSummary?: string,
    isBlind?: boolean
  ): Promise<number> {
    const userMsgs = allMessages.filter((m) => m.role === "user");
    const stageVersion = meeting.stage_version;
    let appendedCount = 0;

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
        const generated = await this.generateTextWithProviderFallback(
          {
            provider_id: agent.provider,
            model: agent.model,
            messages: prompt,
            temperature: agent.temperature,
            max_tokens: agent.max_output_tokens,
            timeout_ms: this.getDiscussionTimeoutMs(meeting),
            metadata: { agent_id: agent.id, topic: meeting.topic },
          },
          { signal: this.abortController?.signal },
          { operation: "discussion", allow_mock_fallback: true }
        );
        const resp = generated.response;

        return {
          agent,
          text: resp.text,
          usage: resp.usage,
          turn_index: i,
          reply_targets: replyTargets,
          used_fallback: generated.used_fallback,
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
    if (!currentMeeting || currentMeeting.stage_version !== stageVersion) return appendedCount;

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
          provider_request_id: r.used_fallback
            ? `fallback:${r.agent.provider}->mock`
            : undefined,
        },
      };
      await this.store.appendMessage(msg);
      this.emitEvent(meetingId, "message.final", { message: msg });
      appendedCount += 1;
    }

    return appendedCount;
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

    const maxAttempts = 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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

        const isFallbackOutput =
          output.round_summary.includes("summary unavailable due to facilitator error") ||
          output.disagreements.some((d) => d.includes("facilitator error"));
        if (isFallbackOutput && attempt < maxAttempts) {
          console.warn(
            `[Runner] Facilitator produced fallback output in round ${round} (attempt ${attempt}/${maxAttempts}), retrying.`
          );
          continue;
        }

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
        return;
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        lastError = err as Error;
        if (attempt < maxAttempts) {
          console.warn(
            `[Runner] Facilitator failed in round ${round} (attempt ${attempt}/${maxAttempts}): ${lastError.message}`
          );
          continue;
        }
      }
    }

    if (lastError) {
      console.error("[Runner] Facilitator failed after retries:", lastError);
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
        const generated = await this.generateTextWithProviderFallback(
          {
            provider_id: agent.provider,
            model: agent.model,
            messages: prompt,
            temperature: 0.1,
            max_tokens: 500,
            timeout_ms: this.getVoteTimeoutMs(meeting),
            response_format: { type: "json_object" },
            metadata: { agent_id: agent.id, topic: meeting.topic },
          },
          { signal: this.voteAbortController?.signal },
          { operation: "vote", allow_mock_fallback: true }
        );
        const resp = generated.response;

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
      await this.finishAccepted(meetingId, agg.avg_score, proposal, round);
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

  private async finishAccepted(
    meetingId: string,
    avgScore: number,
    proposal: string,
    round: number
  ): Promise<void> {
    const meeting = await this.store.getMeeting(meetingId);
    if (!meeting) return;

    const finalDocument = await this.generateFinalConsensusDocument(
      meetingId,
      meeting,
      proposal,
      round
    );

    if (!finalDocument.unanimous) {
      await this.finishAborted(
        meetingId,
        `Final result document was not approved by all agents after ${finalDocument.attempts} attempt(s)`,
        finalDocument.markdown
      );
      return;
    }

    const refreshedMeeting = await this.store.getMeeting(meetingId);
    if (!refreshedMeeting) return;

    const [messagesResult, votesResult] = await Promise.all([
      this.store.listMessages({ meeting_id: meetingId }),
      this.store.listVotes({ meeting_id: meetingId }),
    ]);

    const finalAvgScore = finalDocument.avgScore || avgScore;
    const reason = `Consensus reached and final result document approved by all agents (attempt ${finalDocument.attempts})`;
    const concludedAt = new Date().toISOString();
    const summaryMarkdown = buildMeetingReportMarkdown({
      meeting: refreshedMeeting,
      messages: messagesResult.items,
      votes: votesResult.items,
      accepted: true,
      reason,
      concludedAt,
      conclusionMarkdown: finalDocument.markdown,
      avgScore: finalAvgScore,
    });

    const updated = await this.store.updateMeeting(meetingId, {
      state: "FINISHED_ACCEPTED",
      active_vote_session_id: undefined,
      result: {
        accepted: true,
        concluded_at: concludedAt,
        summary_markdown: summaryMarkdown,
        summary_json: {
          final_avg_score: finalAvgScore,
          vote_count: votesResult.items.length,
          message_count: messagesResult.items.length,
          final_document_markdown: finalDocument.markdown,
          final_document_approval: {
            attempts: finalDocument.attempts,
            unanimous: finalDocument.unanimous,
            note: finalDocument.note,
            approvals: finalDocument.approvals.map((vote) => ({
              agent_id: vote.voter_agent_id,
              score: vote.score,
              pass: vote.pass,
              rationale: vote.rationale,
            })),
          },
        },
        reason,
      },
    });
    this.emitEvent(meetingId, "meeting.state_changed", {
      state: "FINISHED_ACCEPTED",
      round: updated.round,
      stage_version: updated.stage_version,
    });
  }

  private async finishAborted(
    meetingId: string,
    reason: string,
    finalDocumentOverride?: string
  ): Promise<void> {
    const meeting = await this.store.getMeeting(meetingId);
    if (!meeting) return;

    const [messagesResult, votesResult] = await Promise.all([
      this.store.listMessages({ meeting_id: meetingId }),
      this.store.listVotes({ meeting_id: meetingId }),
    ]);
    const proposal =
      finalDocumentOverride ?? this.generateProposal(messagesResult.items, meeting.topic);
    const concludedAt = new Date().toISOString();
    const summaryMarkdown = buildMeetingReportMarkdown({
      meeting,
      messages: messagesResult.items,
      votes: votesResult.items,
      accepted: false,
      reason,
      concludedAt,
      conclusionMarkdown: proposal,
    });

    const updated = await this.store.updateMeeting(meetingId, {
      state: "FINISHED_ABORTED",
      active_vote_session_id: undefined,
      result: {
        accepted: false,
        concluded_at: concludedAt,
        summary_markdown: summaryMarkdown,
        summary_json: {
          vote_count: votesResult.items.length,
          message_count: messagesResult.items.length,
          final_document_markdown: proposal,
        },
        reason,
      },
    });
    this.emitEvent(meetingId, "meeting.state_changed", {
      state: "FINISHED_ABORTED",
      round: updated.round,
      stage_version: updated.stage_version,
    });
  }

  private async generateFinalConsensusDocument(
    meetingId: string,
    meeting: Meeting,
    baseProposal: string,
    round: number
  ): Promise<FinalDocumentResult> {
    const enabledAgents = meeting.config.agents.filter((a) => a.enabled);
    if (enabledAgents.length === 0) {
      return {
        markdown: baseProposal,
        attempts: 0,
        unanimous: true,
        approvals: [],
        avgScore: 0,
        note: "No enabled agents",
      };
    }

    const { items: messages } = await this.store.listMessages({ meeting_id: meetingId });
    const initialDraftResult = await this.generateFinalDocumentDraft(meeting, messages, baseProposal);
    let draft = initialDraftResult.markdown.trim() ? initialDraftResult.markdown : baseProposal;
    if (!initialDraftResult.succeeded) {
      return {
        markdown: draft,
        attempts: 0,
        unanimous: false,
        approvals: [],
        avgScore: 0,
        note: `Final result document generation failed after retries: ${initialDraftResult.error ?? "unknown error"}`,
      };
    }

    const maxAttempts = 3;
    let lastVotes: Vote[] = [];
    let lastAvgScore = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const currentMeeting = await this.store.getMeeting(meetingId);
      if (!currentMeeting || currentMeeting.state !== "RUNNING_VOTE") {
        return {
          markdown: draft,
          attempts: attempt,
          unanimous: false,
          approvals: lastVotes,
          avgScore: lastAvgScore,
          note: "Meeting left RUNNING_VOTE stage during final document approval",
        };
      }

      const sessionId = nanoid();
      const session: VoteSession = {
        id: sessionId,
        meeting_id: meetingId,
        round,
        stage_version: currentMeeting.stage_version,
        proposal_text: draft,
        status: "RUNNING",
        started_at: new Date().toISOString(),
        ended_at: null,
        expected_voter_agent_ids: enabledAgents.map((a) => a.id),
      };
      await this.store.createVoteSession(session);
      await this.store.updateMeeting(meetingId, { active_vote_session_id: sessionId });
      this.emitEvent(meetingId, "vote.session_started", {
        vote_session_id: sessionId,
        stage_version: currentMeeting.stage_version,
        kind: "final_document",
        attempt,
      });

      const approvals = await this.collectFinalDocumentApprovals(
        meetingId,
        currentMeeting,
        enabledAgents,
        sessionId,
        draft
      );
      lastVotes = approvals;

      const agg = aggregateVotes(approvals);
      lastAvgScore = agg.avg_score;
      const unanimous = approvals.length === enabledAgents.length && approvals.every((v) => v.pass);

      await this.store.finalizeVoteSession({
        meeting_id: meetingId,
        vote_session_id: sessionId,
        status: unanimous ? "FINALIZED" : "INCOMPLETE",
        ended_at: new Date().toISOString(),
      });

      this.emitEvent(meetingId, "vote.session_final", {
        vote_session_id: sessionId,
        stage_version: currentMeeting.stage_version,
        accepted: unanimous,
        avg_score: agg.avg_score,
        reason: unanimous
          ? "Final result document approved by all agents"
          : "Final result document not unanimously approved",
        kind: "final_document",
        attempt,
      });

      if (unanimous) {
        return {
          markdown: draft,
          attempts: attempt,
          unanimous: true,
          approvals,
          avgScore: agg.avg_score,
          note: "Approved by all enabled agents",
        };
      }

      const objections = approvals
        .filter((v) => !v.pass)
        .map((v) => `${v.voter_agent_id}: ${v.rationale ?? "No rationale provided"}`);
      const revisedDraftResult = await this.reviseFinalDocumentDraft(
        currentMeeting,
        draft,
        objections,
        messages,
        baseProposal
      );
      if (!revisedDraftResult.succeeded) {
        return {
          markdown: draft,
          attempts: attempt,
          unanimous: false,
          approvals,
          avgScore: agg.avg_score,
          note: `Final result document revise failed after retries: ${revisedDraftResult.error ?? "unknown error"}`,
        };
      }
      draft = revisedDraftResult.markdown.trim() ? revisedDraftResult.markdown : baseProposal;
    }

    return {
      markdown: draft,
      attempts: maxAttempts,
      unanimous: false,
      approvals: lastVotes,
      avgScore: lastAvgScore,
      note: "Exceeded max attempts to get unanimous final document approval",
    };
  }

  private async collectFinalDocumentApprovals(
    meetingId: string,
    meeting: Meeting,
    agents: AgentConfig[],
    voteSessionId: string,
    finalDocument: string
  ): Promise<Vote[]> {
    const reviewTasks = agents.map(async (agent) => {
      const prompt = this.buildFinalDocumentReviewPrompt(meeting, agent, finalDocument);
      try {
        const generated = await this.generateTextWithProviderFallback(
          {
            provider_id: agent.provider,
            model: agent.model,
            messages: prompt,
            temperature: 0.1,
            max_tokens: 600,
            timeout_ms: this.getVoteTimeoutMs(meeting),
            response_format: { type: "json_object" },
            metadata: { agent_id: agent.id, topic: meeting.topic },
          },
          { signal: this.voteAbortController?.signal },
          { operation: "final_document_vote", allow_mock_fallback: true }
        );
        const resp = generated.response;

        const parsed = this.parseVoteResponse(
          resp.text,
          meeting.config.threshold.avg_score_threshold,
          "Failed to parse final document approval response"
        );

        const vote: Vote = {
          id: nanoid(),
          meeting_id: meetingId,
          vote_session_id: voteSessionId,
          voter_agent_id: agent.id,
          score: parsed.score,
          pass: parsed.pass,
          rationale: parsed.rationale,
          stage_version: meeting.stage_version,
          created_at: new Date().toISOString(),
        };

        const currentMeeting = await this.store.getMeeting(meetingId);
        if (!currentMeeting || currentMeeting.stage_version !== meeting.stage_version) {
          return null;
        }

        await this.store.appendVote(vote);
        this.emitEvent(meetingId, "vote.received", { vote, kind: "final_document" });
        return vote;
      } catch (err) {
        if ((err as Error).name === "AbortError") return null;
        console.error(`[Runner] Final document review from ${agent.id} failed:`, err);
        return null;
      }
    });

    const results = await Promise.allSettled(reviewTasks);
    return results
      .filter((r): r is PromiseFulfilledResult<Vote | null> => r.status === "fulfilled")
      .map((r) => r.value)
      .filter((v): v is Vote => v !== null);
  }

  private parseVoteResponse(
    rawText: string,
    thresholdScore: number,
    fallbackReason: string
  ): { score: number; pass: boolean; rationale: string } {
    try {
      const parsed = JSON.parse(rawText) as {
        score?: number;
        pass?: boolean;
        rationale?: string;
      };
      const score = Math.max(
        0,
        Math.min(
          100,
          Math.round(typeof parsed.score === "number" ? parsed.score : thresholdScore)
        )
      );
      const pass = typeof parsed.pass === "boolean" ? parsed.pass : score >= thresholdScore;
      const rationale =
        typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
          ? parsed.rationale.trim()
          : fallbackReason;
      return { score, pass, rationale };
    } catch {
      return {
        score: Math.max(0, Math.min(100, Math.round(thresholdScore))),
        pass: false,
        rationale: fallbackReason,
      };
    }
  }

  private isRecoverableProviderError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return [
      "OpenAI endpoint returned HTML",
      "returned non-JSON",
      "after retries",
      "fetch failed",
      "ECONN",
      "ETIMEDOUT",
      "timeout",
      "API error (5",
      "API error (429",
      "API error (408",
      "API error (409",
      "API error (425",
    ].some((token) => message.includes(token));
  }

  private async generateTextWithProviderFallback(
    req: LLMGenerateTextRequest,
    options: { signal?: AbortSignal } | undefined,
    config: { operation: string; allow_mock_fallback: boolean }
  ): Promise<ResilientGenerateResult> {
    try {
      const response = await this.llmClient.generateText(req, options);
      return {
        response,
        provider_id: req.provider_id,
        model: req.model,
        used_fallback: false,
      };
    } catch (primaryErr) {
      if (
        !config.allow_mock_fallback ||
        req.provider_id === "mock" ||
        !this.isRecoverableProviderError(primaryErr)
      ) {
        throw primaryErr;
      }

      try {
        console.warn(
          `[Runner] ${config.operation} primary provider failed for ${req.provider_id}/${req.model}, fallback to mock.`
        );
        const response = await this.llmClient.generateText(
          {
            ...req,
            provider_id: "mock",
            model: "mock-default",
            metadata: {
              ...(req.metadata ?? {}),
              fallback_from_provider: req.provider_id,
              fallback_from_model: req.model,
            },
          },
          options
        );
        return {
          response,
          provider_id: "mock",
          model: "mock-default",
          used_fallback: true,
        };
      } catch (fallbackErr) {
        const primaryMsg =
          primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        const fallbackMsg =
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new Error(
          `${config.operation} failed on primary provider (${primaryMsg}) and mock fallback (${fallbackMsg})`
        );
      }
    }
  }

  private async generateFinalDocumentDraft(
    meeting: Meeting,
    messages: Message[],
    baseProposal: string
  ): Promise<FinalEditorResult> {
    const recentDiscussion = messages
      .filter((m) => m.role !== "system" || m.system_id === "facilitator")
      .slice(-24)
      .map((m) => {
        const speaker = m.agent_id ?? m.system_id ?? "user";
        return `[${speaker}] ${m.content.slice(0, 600)}`;
      })
      .join("\n\n");
    const limitedBaseProposal = this.truncatePromptText(baseProposal, 5000);
    const limitedRecentDiscussion = this.truncatePromptText(recentDiscussion, 7000);

    const prompt: LLMChatMessage[] = [
      {
        role: "system",
        content:
          "You are the final editor for a multi-agent meeting. Output only Markdown (no code fences). Produce a complete, decision-ready result document.",
      },
      {
        role: "user",
        content: [
          `Topic: ${meeting.topic}`,
          "",
          "Base conclusion draft:",
          limitedBaseProposal,
          "",
          "Recent discussion highlights:",
          limitedRecentDiscussion || "(No recent discussion available)",
          "",
          "Write a FINAL RESULT DOCUMENT in Markdown with these sections:",
          "1) Decision",
          "2) Scope and Assumptions",
          "3) Key Evidence and Trade-offs",
          "4) Agreed Plan (numbered)",
          "5) Action Items (table: owner | action | deadline)",
          "6) Risks and Mitigations",
          "7) Open Questions",
          "8) Acceptance Criteria",
          "",
          "The document must be specific, internally consistent, and implementable.",
        ].join("\n"),
      },
    ];

    return this.runFinalEditorRequest({
      meeting,
      prompt,
      fallbackText: baseProposal,
      operation: "generate",
    });
  }

  private async reviseFinalDocumentDraft(
    meeting: Meeting,
    currentDraft: string,
    objections: string[],
    messages: Message[],
    fallbackDraft: string
  ): Promise<FinalEditorResult> {
    const context = messages
      .filter((m) => m.role === "agent")
      .slice(-12)
      .map((m) => `[${m.agent_id}] ${m.content.slice(0, 300)}`)
      .join("\n");
    const limitedDraft = this.truncatePromptText(currentDraft, 7000);
    const limitedContext = this.truncatePromptText(context, 3500);
    const limitedObjections = objections
      .map((o) => this.truncatePromptText(o, 400))
      .slice(0, 12);

    const prompt: LLMChatMessage[] = [
      {
        role: "system",
        content:
          "Revise the final result document to satisfy reviewer objections. Output only Markdown and keep the same section structure.",
      },
      {
        role: "user",
        content: [
          `Topic: ${meeting.topic}`,
          "",
          "Current draft:",
          limitedDraft,
          "",
          "Reviewer objections:",
          limitedObjections.length > 0
            ? limitedObjections.map((o) => `- ${o}`).join("\n")
            : "- No objections provided",
          "",
          "Additional context:",
          limitedContext || "(No extra context)",
          "",
          "Please return a revised FINAL RESULT DOCUMENT that addresses objections while staying concrete.",
        ].join("\n"),
      },
    ];

    return this.runFinalEditorRequest({
      meeting,
      prompt,
      fallbackText: currentDraft || fallbackDraft,
      operation: "revise",
    });
  }

  private buildFinalDocumentReviewPrompt(
    meeting: Meeting,
    agent: AgentConfig,
    finalDocument: string
  ): LLMChatMessage[] {
    return [
      {
        role: "system",
        content: `${agent.system_prompt}

You are reviewing the final result document for approval.
Output ONLY valid JSON:
{"score": 0-100, "pass": true/false, "rationale": "brief reason"}

Rules:
- pass=true only if you can fully approve this document as final output.
- If pass=false, rationale must mention what must change.`,
      },
      {
        role: "user",
        content: `Topic: ${meeting.topic}

Final result document to review:
${finalDocument}

Return approval JSON only.`,
      },
    ];
  }

  private resolveFinalEditors(meeting: Meeting): Array<{ provider_id: string; model: string }> {
    const firstEnabled = meeting.config.agents.find((a) => a.enabled);
    const primary = {
      provider_id: meeting.config.facilitator.provider ?? firstEnabled?.provider ?? "mock",
      model: meeting.config.facilitator.model ?? firstEnabled?.model ?? "mock-default",
    };

    const candidates = [
      primary,
      ...meeting.config.agents
        .filter((a) => a.enabled)
        .map((a) => ({ provider_id: a.provider, model: a.model })),
    ];

    const availableProviders = new Set(this.llmClient.listProviders().map((p) => p.id));
    const dedup = new Set<string>();
    const result: Array<{ provider_id: string; model: string }> = [];

    for (const candidate of candidates) {
      if (!candidate.provider_id || !candidate.model) continue;
      if (!availableProviders.has(candidate.provider_id)) continue;
      const key = `${candidate.provider_id}::${candidate.model}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
      result.push(candidate);
    }

    if (result.length === 0) {
      return [{ provider_id: "mock", model: "mock-default" }];
    }
    return result;
  }

  private async runFinalEditorRequest(input: {
    meeting: Meeting;
    prompt: LLMChatMessage[];
    fallbackText: string;
    operation: "generate" | "revise";
  }): Promise<FinalEditorResult> {
    const editors = this.resolveFinalEditors(input.meeting);
    const maxPasses = 3;
    let lastError: Error | null = null;
    let totalAttempts = 0;

    for (let pass = 1; pass <= maxPasses; pass++) {
      for (const editor of editors) {
        totalAttempts += 1;
        try {
          const resp = await this.llmClient.generateText(
            {
              provider_id: editor.provider_id,
              model: editor.model,
              messages: input.prompt,
              temperature: 0.2,
              max_tokens: input.operation === "revise" ? 2200 : 2600,
              timeout_ms: this.getFinalDocumentTimeoutMs(input.meeting),
              metadata: { agent_id: "facilitator", topic: input.meeting.topic },
            },
            { signal: this.voteAbortController?.signal }
          );
          const text = resp.text?.trim();
          if (!text) throw new Error("Empty response text");
          return {
            markdown: text,
            succeeded: true,
            attempts: totalAttempts,
          };
        } catch (err) {
          if ((err as Error).name === "AbortError") throw err;
          lastError = err as Error;
          console.warn(
            `[Runner] Final document ${input.operation} failed with ${editor.provider_id}/${editor.model}: ${lastError.message}`
          );
        }
      }

      if (!lastError || !this.isRecoverableProviderError(lastError) || pass >= maxPasses) {
        break;
      }
      console.warn(
        `[Runner] Final document ${input.operation} retry pass ${pass + 1}/${maxPasses} after recoverable error: ${lastError.message}`
      );
    }

    const message = lastError?.message ?? "unknown error";
    console.error(
      `[Runner] Failed to ${input.operation} final document with all editors after retries: ${message}`
    );
    return {
      markdown: input.fallbackText,
      succeeded: false,
      attempts: totalAttempts,
      error: message,
    };
  }

  private truncatePromptText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n\n[Truncated for reliability]`;
  }

  private getDiscussionTimeoutMs(meeting: Meeting): number {
    return Math.max(60_000, meeting.config.threshold.vote_timeout_ms);
  }

  private getVoteTimeoutMs(meeting: Meeting): number {
    return Math.max(15_000, meeting.config.threshold.vote_timeout_ms);
  }

  private getFinalDocumentTimeoutMs(meeting: Meeting): number {
    return Math.max(90_000, meeting.config.facilitator.timeout_ms);
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
