import type { LLMClient, LLMProvider, LLMGenerateTextRequest, LLMGenerateTextResponse, ProviderInfo, ModelInfo, CustomProviderConfig } from "./types";
import { OpenAIProvider } from "./openai-provider";

export class LLMRegistry implements LLMClient {
  private providers = new Map<string, LLMProvider>();
  private customConfigs = new Map<string, CustomProviderConfig>();

  register(provider: LLMProvider): void {
    this.providers.set(provider.provider_id, provider);
  }

  registerCustom(config: CustomProviderConfig): void {
    const provider = new OpenAIProvider({
      provider_id: config.id,
      provider_name: config.name,
      api_key: config.api_key,
      base_url: config.base_url,
      models: config.models,
    });
    this.providers.set(config.id, provider);
    this.customConfigs.set(config.id, config);
  }

  unregisterCustom(providerId: string): boolean {
    if (!this.customConfigs.has(providerId)) return false;
    this.providers.delete(providerId);
    this.customConfigs.delete(providerId);
    return true;
  }

  updateCustom(config: CustomProviderConfig): boolean {
    if (!this.customConfigs.has(config.id)) return false;
    this.registerCustom(config);
    return true;
  }

  getCustomConfig(id: string): CustomProviderConfig | undefined {
    return this.customConfigs.get(id);
  }

  listCustomConfigs(): CustomProviderConfig[] {
    return Array.from(this.customConfigs.values());
  }

  hasProvider(id: string): boolean {
    return this.providers.has(id);
  }

  async generateText(
    req: LLMGenerateTextRequest,
    options?: { signal?: AbortSignal }
  ): Promise<LLMGenerateTextResponse> {
    const provider = this.providers.get(req.provider_id);
    if (!provider) {
      throw new Error(`LLM provider not found: ${req.provider_id}`);
    }
    return provider.generateText(req, options);
  }

  listProviders(): ProviderInfo[] {
    return Array.from(this.providers.values()).map((p) => ({
      id: p.provider_id,
      name: p.provider_name,
      configured: true,
      models: p.listModels(),
      is_custom: this.customConfigs.has(p.provider_id),
    }));
  }

  listModels(providerId: string): ModelInfo[] {
    const provider = this.providers.get(providerId);
    if (!provider) return [];
    return provider.listModels();
  }
}
