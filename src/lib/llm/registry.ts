import type { LLMClient, LLMProvider, LLMGenerateTextRequest, LLMGenerateTextResponse, ProviderInfo, ModelInfo, CustomProviderConfig } from "./types";
import { OpenAIProvider } from "./openai-provider";

const AUTO_PROVIDER_ID = "auto";

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
    if (req.provider_id === AUTO_PROVIDER_ID) {
      const resolvedProviderId = this.resolveProviderIdForModel(req.model);
      if (!resolvedProviderId) {
        const available = Array.from(this.providers.keys()).join(", ");
        throw new Error(
          `Unable to resolve provider for model "${req.model}" (provider_id="${AUTO_PROVIDER_ID}"). ` +
          `Please set provider_id explicitly. Available providers: ${available || "(none)"}.`
        );
      }

      const resolvedProvider = this.providers.get(resolvedProviderId);
      if (!resolvedProvider) {
        throw new Error(
          `LLM provider not found: ${resolvedProviderId} (resolved from model "${req.model}")`
        );
      }

      return resolvedProvider.generateText({ ...req, provider_id: resolvedProviderId }, options);
    }

    const provider = this.providers.get(req.provider_id);
    if (!provider) {
      throw new Error(`LLM provider not found: ${req.provider_id}`);
    }
    return provider.generateText(req, options);
  }

  private resolveProviderIdForModel(model: string): string | null {
    const normalizedModel = model.trim();
    if (!normalizedModel) return null;

    const hasProvider = (id: string) => this.providers.has(id);

    if (/^mock[-_]/i.test(normalizedModel)) return hasProvider("mock") ? "mock" : null;
    if (/^claude[-_]/i.test(normalizedModel)) return hasProvider("anthropic") ? "anthropic" : null;
    if (/^gemini[-_]/i.test(normalizedModel)) return hasProvider("gemini") ? "gemini" : null;
    if (/^gpt[-_]/i.test(normalizedModel) || /^chatgpt[-_]/i.test(normalizedModel) || /^o\d/i.test(normalizedModel)) {
      return hasProvider("openai") ? "openai" : null;
    }

    for (const [id, provider] of this.providers) {
      if (provider.listModels().some((m) => m.id === normalizedModel)) return id;
    }

    const providerIds = Array.from(this.providers.keys());
    const nonMock = providerIds.filter((id) => id !== "mock");
    if (nonMock.length === 1) return nonMock[0];
    if (providerIds.length === 1) return providerIds[0];

    return null;
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
