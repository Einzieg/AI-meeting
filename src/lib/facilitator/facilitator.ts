import { nanoid } from "nanoid";
import type { LLMClient, LLMChatMessage } from "../llm/types";
import type { FacilitatorInput, FacilitatorOutput } from "./types";
import { FacilitatorOutputSchema } from "./types";
import type { FacilitatorConfig } from "../domain/config";

const FACILITATOR_SYSTEM_PROMPT = `You are a meeting facilitator. Your job is to help converge the discussion, NOT to judge or make decisions.

Analyze the discussion and output ONLY valid JSON with this exact structure:
{
  "disagreements": ["point 1", "point 2"],
  "proposed_patch": "minimal modification to the current proposal",
  "next_focus": ["question 1 for next round"],
  "round_summary": "200-400 word summary of this round's key developments"
}

Rules:
- disagreements: 1-3 main points of contention
- proposed_patch: smallest possible change to address disagreements
- next_focus: 1-2 specific questions the next round MUST address
- round_summary: concise summary covering new information and changes`;

export class FacilitatorService {
  constructor(
    private llmClient: LLMClient,
    private config: FacilitatorConfig
  ) {}

  async run(input: FacilitatorInput): Promise<FacilitatorOutput> {
    const messages = this.buildMessages(input);
    const providerId = this.config.provider ?? "mock";
    const model = this.config.model ?? "default";

    // Attempt with JSON format
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await this.llmClient.generateText({
          provider_id: providerId,
          model,
          messages,
          temperature: this.config.temperature,
          max_tokens: this.config.max_output_tokens,
          timeout_ms: this.config.timeout_ms,
          response_format: { type: "json_object" },
          metadata: { agent_id: "facilitator", topic: input.topic },
        });

        const parsed = JSON.parse(resp.text);
        return FacilitatorOutputSchema.parse(parsed);
      } catch (err) {
        lastError = err as Error;
        // Retry with correction prompt on first failure
        if (attempt === 0) {
          messages.push({
            role: "user",
            content: `Your previous response was invalid JSON or didn't match the required schema. Error: ${lastError.message}. Please try again with valid JSON.`,
          });
        }
      }
    }

    // Fallback: generate plain text summary
    return this.fallback(input, lastError);
  }

  private buildMessages(input: FacilitatorInput): LLMChatMessage[] {
    const msgs: LLMChatMessage[] = [
      { role: "system", content: FACILITATOR_SYSTEM_PROMPT },
    ];

    let context = `Topic: ${input.topic}\nRound: ${input.round}\n`;
    if (input.rolling_summary) {
      context += `\nPrevious Summary:\n${input.rolling_summary}\n`;
    }
    context += `\nCurrent Proposal:\n${input.proposal_text}\n`;
    if (input.vote_summary) {
      context += `\nVote Results: avg=${input.vote_summary.avg_score}, min=${input.vote_summary.min_score}, max=${input.vote_summary.max_score}\n`;
    }
    context += `\nRecent Messages:\n`;
    for (const m of input.recent_messages) {
      const speaker = m.agent_id ?? m.system_id ?? "user";
      context += `[${speaker}]: ${m.content.slice(0, 500)}\n`;
    }

    msgs.push({ role: "user", content: context });
    return msgs;
  }

  private fallback(input: FacilitatorInput, error: Error | null): FacilitatorOutput {
    console.error("[Facilitator] JSON parsing failed after retry, using fallback", error?.message);
    return {
      disagreements: ["Unable to extract structured disagreements (facilitator error)"],
      proposed_patch: "Continue discussion with current proposal",
      next_focus: ["Please clarify the main points of contention"],
      round_summary: `Round ${input.round} summary unavailable due to facilitator error. The discussion continues on: ${input.topic}`,
    };
  }
}
