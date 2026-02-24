import { NextResponse } from "next/server";
import { getLLMRegistry } from "@/lib/runtime";
import type { ModelInfo, ProviderInfo } from "@/lib/llm/types";

const AUTO_PROVIDER_ID = "auto";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toModelList(items: Array<{ id: string; name?: string }>): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const item of items) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, name: item.name ?? item.id });
  }
  return out.slice(0, 200);
}

async function fetchJsonWithFallback(urls: string[], headers: Record<string, string>): Promise<unknown | null> {
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(3500),
        redirect: "error",
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > 1024 * 1024) continue;
      try {
        return JSON.parse(text);
      } catch {
        continue;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function fetchOpenAIModels(baseUrl: string, apiKey: string): Promise<ModelInfo[] | null> {
  const base = trimSlash(baseUrl || "https://api.openai.com/v1");
  const urls = [`${base}/models`];
  if (!/\/v\d+$/i.test(base)) urls.push(`${base}/v1/models`);

  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const payload = await fetchJsonWithFallback(urls, headers);
  if (!payload) return null;

  const raw = Array.isArray(payload)
    ? payload
    : (isRecord(payload) && Array.isArray(payload.data) ? payload.data : []);

  const parsed: Array<{ id: string; name?: string }> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = asNonEmptyString(item.id);
    if (!id) continue;
    const name = asNonEmptyString(item.name) ?? undefined;
    parsed.push({ id, name });
  }

  const models = toModelList(parsed);
  return models.length > 0 ? models : null;
}

async function fetchAnthropicModels(baseUrl: string, apiKey: string): Promise<ModelInfo[] | null> {
  const base = trimSlash(baseUrl || "https://api.anthropic.com");
  const urls = /\/v\d+$/i.test(base) ? [`${base}/models`] : [`${base}/v1/models`];
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (apiKey) headers["x-api-key"] = apiKey;

  const payload = await fetchJsonWithFallback(urls, headers);
  if (!payload || !isRecord(payload) || !Array.isArray(payload.data)) return null;

  const parsed: Array<{ id: string; name?: string }> = [];
  for (const item of payload.data) {
    if (!isRecord(item)) continue;
    const id = asNonEmptyString(item.id);
    if (!id) continue;
    const name = asNonEmptyString(item.display_name) ?? asNonEmptyString(item.name) ?? undefined;
    parsed.push({ id, name });
  }

  const models = toModelList(parsed);
  return models.length > 0 ? models : null;
}

async function fetchGeminiModels(baseUrl: string, apiKey: string): Promise<ModelInfo[] | null> {
  const base = trimSlash(baseUrl || "https://generativelanguage.googleapis.com/v1beta");
  const urls: string[] = [];

  const primary = new URL(base.endsWith("/models") ? base : `${base}/models`);
  if (apiKey) primary.searchParams.set("key", apiKey);
  urls.push(primary.toString());

  if (!/\/v\d+/i.test(base) && !base.endsWith("/models")) {
    const fallback = new URL(`${base}/v1/models`);
    if (apiKey) fallback.searchParams.set("key", apiKey);
    urls.push(fallback.toString());
  }

  const payload = await fetchJsonWithFallback(urls, {});
  if (!payload || !isRecord(payload) || !Array.isArray(payload.models)) return null;

  const parsed: Array<{ id: string; name?: string }> = [];
  for (const item of payload.models) {
    if (!isRecord(item)) continue;
    const rawName = asNonEmptyString(item.name) ?? asNonEmptyString(item.id);
    if (!rawName) continue;
    const id = rawName.replace(/^models\//, "");
    const name = asNonEmptyString(item.displayName) ?? id;
    parsed.push({ id, name });
  }

  const models = toModelList(parsed);
  return models.length > 0 ? models : null;
}

function applyOverride(providers: ProviderInfo[], providerId: string, models: ModelInfo[] | null): ProviderInfo[] {
  if (!models || models.length === 0) return providers;
  return providers.map((p) => (p.id === providerId ? { ...p, models } : p));
}

function buildAutoProvider(providers: ProviderInfo[]): ProviderInfo {
  const hasRealProviders = providers.some((p) => p.id !== "mock");
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const p of providers) {
    if (p.id === AUTO_PROVIDER_ID) continue;
    if (hasRealProviders && p.id === "mock") continue;
    for (const m of p.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
  }

  return {
    id: AUTO_PROVIDER_ID,
    name: "Auto (By Model)",
    configured: hasRealProviders,
    models,
  };
}

function insertAfterMock(providers: ProviderInfo[], item: ProviderInfo): ProviderInfo[] {
  const idx = providers.findIndex((p) => p.id === "mock");
  if (idx < 0) return [item, ...providers];
  return [...providers.slice(0, idx + 1), item, ...providers.slice(idx + 1)];
}

// GET /api/providers - List available providers and their models
export async function GET() {
  try {
    const registry = getLLMRegistry();
    let providers = registry.listProviders();

    const hasOpenAI = providers.some((p) => p.id === "openai");
    const hasAnthropic = providers.some((p) => p.id === "anthropic");
    const hasGemini = providers.some((p) => p.id === "gemini");

    const [openaiModels, anthropicModels, geminiModels] = await Promise.all([
      hasOpenAI && process.env.OPENAI_API_KEY
        ? fetchOpenAIModels(process.env.OPENAI_BASE_URL ?? "", process.env.OPENAI_API_KEY)
        : Promise.resolve(null),
      hasAnthropic && process.env.ANTHROPIC_API_KEY
        ? fetchAnthropicModels(process.env.ANTHROPIC_BASE_URL ?? "", process.env.ANTHROPIC_API_KEY)
        : Promise.resolve(null),
      hasGemini && process.env.GOOGLE_GEMINI_API_KEY
        ? fetchGeminiModels(process.env.GOOGLE_GEMINI_BASE_URL ?? "", process.env.GOOGLE_GEMINI_API_KEY)
        : Promise.resolve(null),
    ]);

    providers = applyOverride(providers, "openai", openaiModels);
    providers = applyOverride(providers, "anthropic", anthropicModels);
    providers = applyOverride(providers, "gemini", geminiModels);

    // Pseudo-provider: allows choosing models without manually picking the provider.
    providers = insertAfterMock(providers, buildAutoProvider(providers));

    return NextResponse.json({ ok: true, data: providers });
  } catch (err) {
    console.error("[API] GET /api/providers error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}
