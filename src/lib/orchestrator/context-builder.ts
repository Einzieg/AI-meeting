import type { AgentConfig, MeetingConfig } from "../domain/config";
import type { Message, Meeting } from "../domain/models";
import type { LLMChatMessage } from "../llm/types";

export type ContextInput = {
  topic: string;
  rolling_summary?: string;
  recent_messages: Message[];
  agent: AgentConfig;
  round: number;
  reply_targets: Array<{ agent_id: string; quote?: string }>;
  user_messages_since_last_round: Message[];
};

export function buildAgentPrompt(input: ContextInput): LLMChatMessage[] {
  const msgs: LLMChatMessage[] = [];

  msgs.push({
    role: "system",
    content: input.agent.system_prompt,
  });

  let context = `Topic: ${input.topic}\n`;
  context += `Round: ${input.round}\n\n`;

  if (input.rolling_summary) {
    context += `## Discussion Summary So Far\n${input.rolling_summary}\n\n`;
  }

  if (input.recent_messages.length > 0) {
    context += `## Recent Discussion\n`;
    for (const m of input.recent_messages.slice(-10)) {
      const speaker = m.agent_id ?? m.system_id ?? "user";
      context += `[${speaker}]: ${m.content.slice(0, 800)}\n\n`;
    }
  }

  if (input.user_messages_since_last_round.length > 0) {
    context += `## User Input\n`;
    for (const m of input.user_messages_since_last_round) {
      context += `[User]: ${m.content}\n\n`;
    }
  }

  if (input.reply_targets.length > 0) {
    context += `## You MUST respond to these points:\n`;
    for (const t of input.reply_targets) {
      context += `- From ${t.agent_id}: ${t.quote ?? "(see their latest message)"}\n`;
    }
    context += "\n";
  }

  context += `## Instructions\n`;
  context += `1. Present 1-3 core points. Be concise.\n`;
  context += `2. You MUST directly respond to the reply targets above.\n`;
  context += `3. If you disagree, propose a concrete alternative.\n`;

  msgs.push({ role: "user", content: context });
  return msgs;
}

export function buildVotePrompt(input: {
  topic: string;
  proposal: string;
  agent: AgentConfig;
  rolling_summary?: string;
}): LLMChatMessage[] {
  return [
    {
      role: "system",
      content: `${input.agent.system_prompt}\n\nYou are voting on a proposal. Output ONLY valid JSON:\n{"score": 0-100, "pass": true/false, "rationale": "brief reason"}`,
    },
    {
      role: "user",
      content: `Topic: ${input.topic}\n\n${input.rolling_summary ? `Summary: ${input.rolling_summary}\n\n` : ""}Proposal to vote on:\n${input.proposal}\n\nProvide your vote as JSON.`,
    },
  ];
}

export function selectReplyTargets(
  agents: AgentConfig[],
  currentAgentId: string,
  recentMessages: Message[],
  targetsPerAgent: number
): Array<{ agent_id: string; quote?: string }> {
  const otherAgentMessages = recentMessages.filter(
    (m) => m.role === "agent" && m.agent_id && m.agent_id !== currentAgentId
  );

  // Pick most recent messages from different agents
  const seen = new Set<string>();
  const targets: Array<{ agent_id: string; quote?: string }> = [];

  for (let i = otherAgentMessages.length - 1; i >= 0 && targets.length < targetsPerAgent; i--) {
    const m = otherAgentMessages[i];
    if (m.agent_id && !seen.has(m.agent_id)) {
      seen.add(m.agent_id);
      targets.push({
        agent_id: m.agent_id,
        quote: m.content.slice(0, 200),
      });
    }
  }

  return targets;
}

export function resolveDiscussionMode(
  config: MeetingConfig
): "serial_turn" | "parallel_round" {
  if (config.discussion.mode === "auto") {
    return config.agents.length >= config.discussion.auto_parallel_min_agents
      ? "parallel_round"
      : "serial_turn";
  }
  return config.discussion.mode as "serial_turn" | "parallel_round";
}
