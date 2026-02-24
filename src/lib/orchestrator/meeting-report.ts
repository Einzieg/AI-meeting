import type { Meeting, Message, Vote } from "../domain/models";

export type MeetingReportInput = {
  meeting: Meeting;
  messages: Message[];
  votes: Vote[];
  accepted: boolean;
  reason: string;
  concludedAt: string;
  conclusionMarkdown?: string;
  avgScore?: number;
};

function escapeCell(value: string): string {
  return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function textLimit(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function getAgentName(meeting: Meeting, agentId?: string): string {
  if (!agentId) return "Unknown agent";
  const agent = meeting.config.agents.find((a) => a.id === agentId);
  return agent?.display_name ?? agentId;
}

function getSpeakerLabel(meeting: Meeting, msg: Message): string {
  if (msg.role === "user") return "User";
  if (msg.role === "system") return `System/${msg.system_id ?? "system"}`;
  return getAgentName(meeting, msg.agent_id);
}

function pickLatestVoteSessionId(votes: Vote[]): string | null {
  if (votes.length === 0) return null;
  const latest = [...votes].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
  return latest?.vote_session_id ?? null;
}

function buildVoteTable(meeting: Meeting, votes: Vote[]): string[] {
  if (votes.length === 0) {
    return ["No votes were recorded in the final vote session.", ""];
  }

  const avg = Math.round(votes.reduce((sum, v) => sum + v.score, 0) / votes.length);
  const lines = [
    `Average score: **${avg}**`,
    "",
    "| Agent | Score | Pass | Rationale |",
    "| --- | ---: | :---: | --- |",
  ];

  for (const vote of votes) {
    lines.push(
      `| ${escapeCell(getAgentName(meeting, vote.voter_agent_id))} | ${vote.score} | ${vote.pass ? "Yes" : "No"} | ${escapeCell(vote.rationale ?? "-")} |`
    );
  }
  lines.push("");
  return lines;
}

function groupMessagesByRound(messages: Message[]): Map<number, Message[]> {
  const map = new Map<number, Message[]>();
  for (const msg of [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const round = msg.meta.round ?? 0;
    if (!map.has(round)) map.set(round, []);
    map.get(round)!.push(msg);
  }
  return map;
}

function buildFacilitatorSection(messages: Message[]): string[] {
  const facilitatorMsgs = messages.filter((m) => m.role === "system" && m.system_id === "facilitator");
  if (facilitatorMsgs.length === 0) {
    return ["No facilitator summaries were captured.", ""];
  }

  const lines: string[] = [];
  for (const msg of facilitatorMsgs) {
    lines.push(`### Round ${msg.meta.round}`);
    lines.push("");
    lines.push(textLimit(msg.content, 6000));
    lines.push("");
  }
  return lines;
}

function buildRoundReplay(meeting: Meeting, messages: Message[]): string[] {
  const byRound = groupMessagesByRound(messages);
  const rounds = [...byRound.keys()].sort((a, b) => a - b);

  if (rounds.length === 0) {
    return ["No discussion messages were recorded.", ""];
  }

  const lines: string[] = [];
  for (const round of rounds) {
    lines.push(`### Round ${round}`);
    lines.push("");
    const roundMessages = byRound.get(round) ?? [];

    for (const msg of roundMessages) {
      const speaker = getSpeakerLabel(meeting, msg);
      const preview = textLimit(msg.content, 240);
      lines.push(`- **${speaker}** (${msg.created_at}): ${preview.replace(/\r?\n/g, " ")}`);
    }
    lines.push("");
  }
  return lines;
}

function buildFullTranscript(meeting: Meeting, messages: Message[]): string[] {
  if (messages.length === 0) {
    return ["No transcript available.", ""];
  }

  const lines: string[] = [
    "<details>",
    "<summary>Expand full transcript</summary>",
    "",
  ];

  for (const msg of [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const speaker = getSpeakerLabel(meeting, msg);
    lines.push(`#### Round ${msg.meta.round} - ${speaker} (${msg.created_at})`);
    lines.push("");
    lines.push(msg.content);
    lines.push("");
  }

  lines.push("</details>");
  lines.push("");
  return lines;
}

export function buildMeetingReportMarkdown(input: MeetingReportInput): string {
  const { meeting, messages, votes, accepted, reason, concludedAt, conclusionMarkdown, avgScore } = input;
  const latestVoteSessionId = pickLatestVoteSessionId(votes);
  const finalVotes = latestVoteSessionId ? votes.filter((v) => v.vote_session_id === latestVoteSessionId) : [];

  const lines: string[] = [
    `# AI Meeting Report`,
    "",
    `## Meeting Metadata`,
    `- Topic: ${meeting.topic}`,
    `- Meeting ID: \`${meeting.id}\``,
    `- Outcome: ${accepted ? "Accepted" : "Aborted"}`,
    `- Reason: ${reason}`,
    `- Concluded At: ${concludedAt}`,
    `- Final Round: ${meeting.round}`,
    `- Discussion Mode: ${meeting.effective_discussion_mode ?? meeting.config.discussion.mode}`,
    `- Agents: ${meeting.config.agents.filter((a) => a.enabled).map((a) => a.display_name).join(", ")}`,
    `- Threshold: avg_score >= ${meeting.config.threshold.avg_score_threshold}`,
    `- Round Limits: ${meeting.config.threshold.min_rounds}-${meeting.config.threshold.max_rounds}`,
    "",
    `## Final Result Document`,
    "",
    conclusionMarkdown?.trim().length
      ? conclusionMarkdown.trim()
      : "No final proposal text was captured.",
    "",
    `## Final Vote Session`,
    "",
    `Vote Session ID: \`${latestVoteSessionId ?? "N/A"}\``,
    avgScore !== undefined ? `Final Average Score: **${avgScore}**` : undefined,
    "",
    ...buildVoteTable(meeting, finalVotes),
    `## Facilitator Summaries`,
    "",
    ...buildFacilitatorSection(messages),
    `## Round Replay`,
    "",
    ...buildRoundReplay(meeting, messages),
    `## Full Transcript`,
    "",
    ...buildFullTranscript(meeting, messages),
  ].filter((line): line is string => line !== undefined);

  return lines.join("\n");
}
