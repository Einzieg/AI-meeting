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

const FACILITATOR_TEMPLATES: Record<
  MockStyle,
  (topic: string) => {
    disagreements: string[];
    proposed_patch: string;
    next_focus: string[];
    round_summary: string;
  }
> = {
  neutral: (topic) => ({
    disagreements: [
      "The scope is still broad and lacks explicit priority ordering.",
      "Risk handling is mentioned, but ownership and checkpoints are unclear.",
    ],
    proposed_patch: "Add a phased plan with clear owners, deadlines, and one risk mitigation action per phase.",
    next_focus: [
      "Which deliverables must be completed in phase one?",
      "What concrete risk trigger should cause a rollback or redesign?",
    ],
    round_summary: `In this round on "${topic}", participants converged on a generally workable direction but left several operational details unresolved. The discussion clarified the intended outcome and confirmed broad support for a phased approach, yet disagreement remains on execution order and accountability boundaries. Some agents emphasized speed and incremental delivery, while others requested stronger safeguards before committing resources. Evidence quality improved compared with earlier exchanges, but the group still relies on assumptions rather than explicit acceptance criteria. The current draft proposal appears viable if refined with tighter sequencing, explicit ownership, and clearer risk controls. A minimal patch should preserve momentum while reducing ambiguity: define phase-level deliverables, assign responsible parties, and add measurable checkpoints tied to escalation rules. Overall, the meeting progressed from abstract positioning toward actionable planning, but consensus will likely require one more pass focused on commitment-level details and testable conditions for success.`,
  }),
  optimist: (topic) => ({
    disagreements: [
      "The team agrees on direction but not on how ambitious the first milestone should be.",
      "There is uncertainty about how much experimentation is acceptable before standardization.",
    ],
    proposed_patch: "Start with a small pilot milestone, then expand scope only after a short validation review.",
    next_focus: [
      "What is the smallest milestone that still proves value?",
      "Which validation metric should unlock expansion to the next phase?",
    ],
    round_summary: `The discussion on "${topic}" showed strong momentum and a shared belief that progress is achievable in the near term. Most participants aligned around moving forward quickly, with disagreement centered on the size of the initial commitment rather than the overall direction. Optimistic arguments highlighted opportunity cost and the benefits of early implementation, while cautionary points focused on avoiding premature scale and preserving adaptability. The proposal is close to consensus if the launch sequence is tightened. A practical compromise is to begin with a focused pilot that demonstrates measurable value before broader rollout. This keeps the energy of the group while managing downside exposure. Contributors also surfaced useful ideas for lightweight governance and periodic review, suggesting that alignment is improving. The next round should translate this momentum into concrete acceptance criteria and a clear expansion gate so the group can vote with confidence.`,
  }),
  skeptic: (topic) => ({
    disagreements: [
      "Evidence for expected outcomes is still insufficient.",
      "Failure scenarios and contingency actions are not specific enough.",
    ],
    proposed_patch: "Require a short evidence baseline and explicit failure-response playbook before final approval.",
    next_focus: [
      "What data threshold is required to justify the current assumptions?",
      "Which concrete actions are triggered if key metrics deteriorate?",
    ],
    round_summary: `This round on "${topic}" improved structure but did not fully resolve credibility concerns. Participants narrowed the proposal and identified practical implementation paths, yet the supporting evidence remains uneven and some claims are still speculative. Several speakers requested stronger validation before committing to irreversible steps, especially around downside risk and operational uncertainty. While there is partial alignment on goals, disagreement persists on the confidence level required for a go decision. The proposal can be strengthened with a minimal change: define baseline evidence requirements and a clear fallback protocol if outcomes underperform. That adjustment would preserve progress while addressing the most material objections raised in the discussion. The meeting advanced from broad debate to testable questions, but the group still needs sharper thresholds and response rules to complete convergence.`,
  }),
  strict: (topic) => ({
    disagreements: [
      "Control points exist conceptually but are not mapped to accountable roles.",
      "Compliance and quality criteria are not yet operationalized.",
    ],
    proposed_patch: "Attach explicit owner-role mapping and objective compliance checks to each implementation stage.",
    next_focus: [
      "Which owner signs off each stage and on what criteria?",
      "What mandatory checks must pass before stage transition?",
    ],
    round_summary: `In this round discussing "${topic}", the team refined the proposal but still lacks execution-grade governance detail. Agreement is emerging on direction and structure, however accountability and quality control remain underdefined. Participants acknowledged the need for measurable criteria, yet responsibilities and gate conditions are not consistently assigned. This creates risk of interpretation drift during implementation. A minimal corrective patch is to bind each stage to a named owner role and pre-defined pass/fail checks. This would convert a promising concept into an auditable plan without changing strategic intent. Overall, dialogue quality improved and the proposal became more coherent, but final convergence requires stricter decision controls and clearer stage-transition requirements.`,
  }),
  creative: (topic) => ({
    disagreements: [
      "Participants disagree on how much novelty to introduce in the first iteration.",
      "There is no shared boundary between exploratory work and production-ready decisions.",
    ],
    proposed_patch: "Split the plan into an exploration lane and a delivery lane, with a checkpoint to transfer validated ideas.",
    next_focus: [
      "What experiments belong in exploration versus immediate delivery?",
      "Which validation signal allows an idea to move into production planning?",
    ],
    round_summary: `The round on "${topic}" produced several inventive options and improved the breadth of the solution space. The strongest friction point was not whether innovation is useful, but how to balance experimentation with dependable delivery. Some contributors pushed for bold redesigns, while others argued for incremental upgrades to protect execution certainty. The proposal can absorb both views through a small structural change: separate exploratory experiments from delivery commitments, then connect them with clear validation gates. This keeps creativity productive and prevents planning churn. The discussion moved from isolated ideas toward a more integrated strategy, and participants are closer to alignment than in previous exchanges. The next round should define experiment boundaries, evaluation signals, and transition criteria so the group can retain novelty without sacrificing operational focus.`,
  }),
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
    const isFacilitator =
      agentId === "facilitator" ||
      req.messages.some((m) => m.content.includes("You are a meeting facilitator"));
    const isVote =
      !isFacilitator &&
      (req.response_format?.type === "json_object" ||
        req.messages.some((m) => m.content.includes("vote") || m.content.includes("score")));

    let text: string;
    if (isFacilitator) {
      text = JSON.stringify(FACILITATOR_TEMPLATES[style](topic));
    } else if (isVote) {
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
