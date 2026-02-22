import type {
  LLMProvider,
  LLMGenerateTextRequest,
  LLMGenerateTextResponse,
  ModelInfo,
  ProviderConfig,
} from "./types";

const GEMINI_MODELS: ModelInfo[] = [
  { id: "gemini-2.5-pro-preview-06-05", name: "Gemini 2.5 Pro", context_window: 1048576, max_output_tokens: 65536 },
  { id: "gemini-2.5-flash-preview-05-20", name: "Gemini 2.5 Flash", context_window: 1048576, max_output_tokens: 65536 },
  { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", context_window: 1048576, max_output_tokens: 8192 },
  { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", context_window: 2097152, max_output_tokens: 8192 },
  { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", context_window: 1048576, max_output_tokens: 8192 },
];

export class GeminiProvider implements LLMProvider {
  readonly provider_id = "gemini";
  readonly provider_name = "Google Gemini";
  private apiKey: string;
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    this.apiKey = config.api_key ?? "";
    this.baseUrl = config.base_url ?? "https://generativelanguage.googleapis.com/v1beta";
  }

  listModels(): ModelInfo[] {
    return GEMINI_MODELS;
  }

  async generateText(
    req: LLMGenerateTextRequest,
    options?: { signal?: AbortSignal }
  ): Promise<LLMGenerateTextResponse> {
    const systemMsg = req.messages.find((m) => m.role === "system");
    const nonSystemMsgs = req.messages.filter((m) => m.role !== "system");

    const contents = nonSystemMsgs.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body: Record<string, unknown> = { contents };

    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }

    const generationConfig: Record<string, unknown> = {};
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.max_tokens !== undefined) generationConfig.maxOutputTokens = req.max_tokens;
    if (req.response_format?.type === "json_object") {
      generationConfig.responseMimeType = "application/json";
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const url = `${this.baseUrl}/models/${req.model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "unknown error");
      throw new Error(`Gemini API error (${res.status}): ${err}`);
    }

    const data = await res.json();
    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts
      ?.map((p: { text?: string }) => p.text ?? "")
      .join("") ?? "";

    return {
      text,
      usage: data.usageMetadata ? {
        prompt_tokens: data.usageMetadata.promptTokenCount,
        completion_tokens: data.usageMetadata.candidatesTokenCount,
        total_tokens: data.usageMetadata.totalTokenCount,
      } : undefined,
      raw: data,
    };
  }
}
