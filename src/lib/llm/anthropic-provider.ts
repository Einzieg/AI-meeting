import type {
  LLMProvider,
  LLMGenerateTextRequest,
  LLMGenerateTextResponse,
  ModelInfo,
  ProviderConfig,
} from "./types";

const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-20250514", name: "Claude Opus 4", context_window: 200000, max_output_tokens: 32000 },
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", context_window: 200000, max_output_tokens: 16000 },
  { id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet", context_window: 200000, max_output_tokens: 8192 },
  { id: "claude-3-5-haiku-20241022", name: "Claude 3.5 Haiku", context_window: 200000, max_output_tokens: 8192 },
  { id: "claude-3-opus-20240229", name: "Claude 3 Opus", context_window: 200000, max_output_tokens: 4096 },
  { id: "claude-3-haiku-20240307", name: "Claude 3 Haiku", context_window: 200000, max_output_tokens: 4096 },
];

export class AnthropicProvider implements LLMProvider {
  readonly provider_id = "anthropic";
  readonly provider_name = "Anthropic";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.api_key ?? "";
    this.baseUrl = config.base_url ?? "https://api.anthropic.com";
  }

  listModels(): ModelInfo[] {
    return ANTHROPIC_MODELS;
  }

  async generateText(
    req: LLMGenerateTextRequest,
    options?: { signal?: AbortSignal }
  ): Promise<LLMGenerateTextResponse> {
    const systemMsg = req.messages.find((m) => m.role === "system");
    const nonSystemMsgs = req.messages.filter((m) => m.role !== "system");

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.max_tokens ?? 4096,
      messages: nonSystemMsgs.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    };
    if (systemMsg) body.system = systemMsg.content;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`Anthropic API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const text = data.content
      ?.filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("") ?? "";

    return {
      text,
      usage: data.usage ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      } : undefined,
      raw: data,
    };
  }
}
