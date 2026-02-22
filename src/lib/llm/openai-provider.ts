import type {
  LLMProvider,
  LLMGenerateTextRequest,
  LLMGenerateTextResponse,
  ModelInfo,
  ProviderConfig,
} from "./types";

const OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-4o", name: "GPT-4o", context_window: 128000, max_output_tokens: 16384 },
  { id: "gpt-4o-mini", name: "GPT-4o Mini", context_window: 128000, max_output_tokens: 16384 },
  { id: "gpt-4-turbo", name: "GPT-4 Turbo", context_window: 128000, max_output_tokens: 4096 },
  { id: "gpt-4", name: "GPT-4", context_window: 8192, max_output_tokens: 8192 },
  { id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo", context_window: 16385, max_output_tokens: 4096 },
  { id: "o1", name: "o1", context_window: 200000, max_output_tokens: 100000 },
  { id: "o1-mini", name: "o1 Mini", context_window: 128000, max_output_tokens: 65536 },
  { id: "o3-mini", name: "o3 Mini", context_window: 200000, max_output_tokens: 100000 },
];

export type OpenAICompatibleConfig = ProviderConfig & {
  provider_id?: string;
  provider_name?: string;
  models?: ModelInfo[];
};

export class OpenAIProvider implements LLMProvider {
  readonly provider_id: string;
  readonly provider_name: string;
  private apiKey: string;
  private baseUrl: string;
  private models: ModelInfo[];

  constructor(config: OpenAICompatibleConfig) {
    this.provider_id = config.provider_id ?? "openai";
    this.provider_name = config.provider_name ?? "OpenAI";
    this.apiKey = config.api_key ?? "";
    this.baseUrl = config.base_url ?? "https://api.openai.com/v1";
    this.models = config.models ?? OPENAI_MODELS;
  }

  listModels(): ModelInfo[] {
    return this.models;
  }

  async generateText(
    req: LLMGenerateTextRequest,
    options?: { signal?: AbortSignal }
  ): Promise<LLMGenerateTextResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.max_tokens !== undefined) body.max_tokens = req.max_tokens;
    if (req.response_format) {
      if (req.response_format.type === "json_object") {
        body.response_format = { type: "json_object" };
      } else if (req.response_format.type === "json_schema") {
        body.response_format = {
          type: "json_schema",
          json_schema: { name: req.response_format.name, schema: req.response_format.schema },
        };
      }
    }

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`OpenAI API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      usage: data.usage ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
      } : undefined,
      raw: data,
    };
  }
}
