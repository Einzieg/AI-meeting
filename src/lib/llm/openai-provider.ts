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

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function looksLikeHtml(contentType: string, text: string): boolean {
  if (contentType.includes("text/html")) return true;
  const trimmed = text.trimStart().toLowerCase();
  return trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
}

function truncateForLog(text: string, max = 220): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...`;
}

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
    this.baseUrl = stripTrailingSlash(config.base_url ?? "https://api.openai.com/v1");
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

    const requestOptions = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    } as const;

    const primaryUrl = `${this.baseUrl}/chat/completions`;
    const fallbackUrl = /\/v\d+$/i.test(this.baseUrl)
      ? null
      : `${this.baseUrl}/v1/chat/completions`;

    const requestOnce = async (url: string): Promise<{
      url: string;
      status: number;
      ok: boolean;
      contentType: string;
      text: string;
    }> => {
      const res = await fetch(url, requestOptions);
      const text = await res.text().catch(() => "");
      return {
        url,
        status: res.status,
        ok: res.ok,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        text,
      };
    };

    let response = await requestOnce(primaryUrl);

    // Compatibility fallback: many OpenAI-compatible gateways require "/v1".
    if (
      fallbackUrl &&
      (response.status === 404 || looksLikeHtml(response.contentType, response.text))
    ) {
      response = await requestOnce(fallbackUrl);
    }

    if (!response.ok) {
      throw new Error(
        `OpenAI API error (${response.status}) at ${response.url}: ${truncateForLog(response.text)}`
      );
    }

    let data: unknown;
    try {
      data = JSON.parse(response.text);
    } catch {
      throw new Error(
        `OpenAI API returned non-JSON at ${response.url} (content-type: ${response.contentType}): ${truncateForLog(response.text)}`
      );
    }

    const parsed = data as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
      };
    };
    const choice = parsed.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      usage: parsed.usage ? {
        prompt_tokens: parsed.usage.prompt_tokens,
        completion_tokens: parsed.usage.completion_tokens,
        total_tokens: parsed.usage.total_tokens,
      } : undefined,
      raw: parsed,
    };
  }
}
