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

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524]);

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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    });
  });
}

function calcRetryDelay(attempt: number): number {
  // 250ms, 500ms, 1000ms (+ small jitter)
  const base = 250 * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 120);
  return base + jitter;
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
    } as const;

    const primaryUrl = `${this.baseUrl}/chat/completions`;
    const fallbackUrl = /\/v\d+$/i.test(this.baseUrl)
      ? null
      : `${this.baseUrl}/v1/chat/completions`;
    const candidateUrls = fallbackUrl && fallbackUrl !== primaryUrl
      ? [primaryUrl, fallbackUrl]
      : [primaryUrl];
    const maxRetries = 2;

    const timeoutMs = Math.max(5_000, Math.min(120_000, req.timeout_ms ?? 60_000));

    const requestOnce = async (url: string): Promise<{
      url: string;
      status: number;
      ok: boolean;
      contentType: string;
      text: string;
    }> => {
      const controller = new AbortController();
      const upstreamSignal = options?.signal;
      const onAbort = () => controller.abort();
      let timer: ReturnType<typeof setTimeout> | null = null;

      if (upstreamSignal) {
        if (upstreamSignal.aborted) {
          controller.abort();
        } else {
          upstreamSignal.addEventListener("abort", onAbort, { once: true });
        }
      }

      timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(url, { ...requestOptions, signal: controller.signal });
        const text = await res.text().catch(() => "");
        return {
          url,
          status: res.status,
          ok: res.ok,
          contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
          text,
        };
      } catch (err) {
        if (controller.signal.aborted && !upstreamSignal?.aborted) {
          throw new Error(`OpenAI request timeout (${timeoutMs}ms) at ${url}`);
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        if (upstreamSignal) {
          upstreamSignal.removeEventListener("abort", onAbort);
        }
      }
    };

    const requestWithRetry = async (url: string): Promise<{
      url: string;
      status: number;
      ok: boolean;
      contentType: string;
      text: string;
    }> => {
      let lastError: Error | null = null;
      let lastResponse: Awaited<ReturnType<typeof requestOnce>> | null = null;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const response = await requestOnce(url);
          lastResponse = response;

          if (response.ok) return response;

          const retryable =
            RETRYABLE_STATUS.has(response.status) ||
            (looksLikeHtml(response.contentType, response.text) && response.status >= 500);

          if (!retryable || attempt === maxRetries) return response;
        } catch (err) {
          lastError = err as Error;
          if ((err as Error).name === "AbortError" || attempt === maxRetries) {
            throw err;
          }
        }

        await delay(calcRetryDelay(attempt), options?.signal);
      }

      if (lastResponse) return lastResponse;
      throw lastError ?? new Error(`OpenAI request failed at ${url}`);
    };

    let response: Awaited<ReturnType<typeof requestOnce>> | null = null;
    let lastError: Error | null = null;

    for (const url of candidateUrls) {
      try {
        const current = await requestWithRetry(url);
        if (current.ok && !looksLikeHtml(current.contentType, current.text)) {
          response = current;
          break;
        }

        // For compatibility / edge proxies, continue trying the fallback URL.
        if (url === primaryUrl && fallbackUrl) {
          const shouldTryFallback =
            (current.ok && looksLikeHtml(current.contentType, current.text)) ||
            current.status === 404 ||
            looksLikeHtml(current.contentType, current.text) ||
            RETRYABLE_STATUS.has(current.status);
          if (shouldTryFallback) {
            response = current;
            continue;
          }
        }

        response = current;
        break;
      } catch (err) {
        lastError = err as Error;
        if ((err as Error).name === "AbortError") throw err;
        if (url !== primaryUrl || !fallbackUrl) break;
      }
    }

    if (!response || !response.ok) {
      if (response) {
        throw new Error(
          `OpenAI API error (${response.status}) at ${response.url} after retries: ${truncateForLog(response.text)}`
        );
      }
      throw new Error(
        `OpenAI API request failed after retries: ${lastError?.message ?? "unknown error"}`
      );
    }

    if (looksLikeHtml(response.contentType, response.text)) {
      throw new Error(
        `OpenAI endpoint returned HTML at ${response.url}. Check BASE_URL/proxy path (expected JSON API).`
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
