export type LLMChatRole = "system" | "user" | "assistant";

export type LLMChatMessage = {
  role: LLMChatRole;
  content: string;
};

export type LLMResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; name: string; schema: unknown };

export type LLMGenerateTextRequest = {
  provider_id: string;
  model: string;
  messages: LLMChatMessage[];
  temperature?: number;
  max_tokens?: number;
  timeout_ms?: number;
  response_format?: LLMResponseFormat;
  metadata?: Record<string, string | number | boolean>;
};

export type LLMUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type LLMGenerateTextResponse = {
  text: string;
  usage?: LLMUsage;
  raw?: unknown;
};

export type ModelInfo = {
  id: string;
  name: string;
  context_window?: number;
  max_output_tokens?: number;
};

export type ProviderInfo = {
  id: string;
  name: string;
  configured: boolean;
  models: ModelInfo[];
  is_custom?: boolean;
};

export type ProviderConfig = {
  api_key?: string;
  base_url?: string;
};

export interface LLMProvider {
  provider_id: string;
  provider_name: string;
  listModels(): ModelInfo[];
  generateText(
    req: LLMGenerateTextRequest,
    options?: { signal?: AbortSignal }
  ): Promise<LLMGenerateTextResponse>;
}

export interface LLMClient {
  generateText(
    req: LLMGenerateTextRequest,
    options?: { signal?: AbortSignal }
  ): Promise<LLMGenerateTextResponse>;
  listProviders(): ProviderInfo[];
  listModels(providerId: string): ModelInfo[];
}

export type CustomProviderConfig = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models: ModelInfo[];
  created_at: string;
};
