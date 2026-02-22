import type {
  LLMProvider,
  LLMGenerateTextRequest,
  LLMGenerateTextResponse,
  ModelInfo,
} from "./types";

export type MockStyle = "neutral" | "optimist" | "skeptic" | "strict" | "creative";

export type MockFault =
  | { type: "none" }
  | { type: "timeout"; after_ms: number }
  | { type: "throw"; message: string }
  | { type: "invalid_json" };

export type MockProviderConfig = {
  default_style: MockStyle;
  per_agent_style?: Record<string, MockStyle>;
  fault?: MockFault;
  latency_ms?: number;
};

const STYLE_TEMPLATES: Record<MockStyle, (topic: string, agentId: string) => string> = {
  neutral: (topic, agentId) =>
    `[${agentId}] Regarding "${topic}": This is a balanced perspective considering both advantages and potential drawbacks. We should weigh the evidence carefully before reaching a conclusion.`,
  optimist: (topic, agentId) =>
    `[${agentId}] I'm excited about "${topic}"! The potential benefits are significant. This approach could lead to breakthrough improvements and I strongly support moving forward.`,
  skeptic: (topic, agentId) =>
    `[${agentId}] Let me challenge the assumptions around "${topic}". Have we considered the risks? What evidence supports this direction? I think we need more data before proceeding.`,
  strict: (topic, agentId) =>
    `[${agentId}] Regarding "${topic}": We must ensure compliance with established standards. The proposal needs rigorous validation against our criteria before any commitment.`,
  creative: (topic, agentId) =>
    `[${agentId}] What if we approach "${topic}" from a completely different angle? Let me propose an unconventional solution that combines multiple perspectives into something novel.`,
};

const VOTE_TEMPLATES: Record<MockStyle, () => { score: number; pass: boolean; rationale: string }> = {
  neutral: () => ({ score: 75, pass: false, rationale: "The proposal is reasonable but could benefit from more concrete action items." }),
  optimist: () => ({ score: 90, pass: true, rationale: "Excellent proposal! Well-structured and addresses key concerns effectively." }),
  skeptic: () => ({ score: 60, pass: false, rationale: "Several concerns remain unaddressed. Need more evidence and risk mitigation." }),
  strict: () => ({ score: 70, pass: false, rationale: "Meets basic requirements but falls short on some compliance criteria." }),
  creative: () => ({ score: 85, pass: true, rationale: "Innovative approach with good potential. Minor refinements needed." }),
};

export class MockProvider implements LLMProvider {
  readonly provider_id = "mock";
  readonly provider_name = "Mock (Testing)";
  private config: MockProviderConfig;

  constructor(config?: Partial<MockProviderConfig>) {
    this.config = {
      default_style: config?.default_style ?? "neutral",
      per_agent_style: config?.per_agent_style,
      fault: config?.fault ?? { type: "none" },
      latency_ms: config?.latency_ms ?? 500,
    };
  }

  listModels(): ModelInfo[] {
    return [
      { id: "mock-default", name: "Mock Default", context_window: 8192, max_output_tokens: 4096 },
      { id: "mock-fast", name: "Mock Fast", context_window: 4096, max_output_tokens: 2048 },
    ];
  }

  async generateText(
    req: LLMGenerateTextRequest,
    options?: { signal?: AbortSignal }
  ): Promise<LLMGenerateTextResponse> {
    // Simulate latency
    await this.delay(this.config.latency_ms ?? 500, options?.signal);

    // Apply fault injection
    await this.applyFault(options?.signal);

    const agentId = (req.metadata?.agent_id as string) ?? "unknown";
    const topic = (req.metadata?.topic as string) ?? "the topic";
    const style = this.config.per_agent_style?.[agentId] ?? this.config.default_style;
    const isVote = req.response_format?.type === "json_object" ||
                   req.messages.some(m => m.content.includes("vote") || m.content.includes("score"));

    let text: string;
    if (isVote) {
      const vote = VOTE_TEMPLATES[style]();
      text = JSON.stringify(vote);
    } else {
      text = STYLE_TEMPLATES[style](topic, agentId);
    }

    const usage = {
      prompt_tokens: Math.floor(req.messages.reduce((s, m) => s + m.content.length / 4, 0)),
      completion_tokens: Math.floor(text.length / 4),
      total_tokens: 0,
    };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;

    return { text, usage };
  }

  private async delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }

  private async applyFault(signal?: AbortSignal): Promise<void> {
    const fault = this.config.fault;
    if (!fault || fault.type === "none") return;

    switch (fault.type) {
      case "timeout":
        await this.delay(fault.after_ms, signal);
        throw new Error("Mock timeout exceeded");
      case "throw":
        throw new Error(fault.message);
      case "invalid_json":
        // Will be handled by caller expecting JSON
        break;
    }
  }
}
