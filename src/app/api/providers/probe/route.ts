import { NextResponse } from "next/server";
import { z } from "zod";

const ProbeSchema = z.object({
  base_url: z.string().url().refine((url) => {
    try {
      const u = new URL(url);
      return ["http:", "https:"].includes(u.protocol) && !u.hash && !u.username;
    } catch {
      return false;
    }
  }, "Only http/https URLs without fragments or credentials are allowed"),
  api_key: z.string().default(""),
});

type ProbeFormat = "anthropic" | "gemini" | "openai";
type NormalizedModel = { id: string; name: string };

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function detectProbeFormat(request: Request): ProbeFormat {
  const hasAnthropicKey = !!request.headers.get("x-api-key");
  const hasAnthropicVersion = !!request.headers.get("anthropic-version");
  if (hasAnthropicKey && hasAnthropicVersion) return "anthropic";

  const url = new URL(request.url);
  const hasGeminiKeyHeader = !!request.headers.get("x-goog-api-key");
  const hasGeminiKeyQuery = !!url.searchParams.get("key");
  if (hasGeminiKeyHeader || hasGeminiKeyQuery) return "gemini";

  return "openai";
}

function extractModels(raw: unknown): NormalizedModel[] {
  const out: NormalizedModel[] = [];
  const seen = new Set<string>();

  const push = (idRaw: unknown, nameRaw?: unknown) => {
    const id = asString(idRaw);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const name = asString(nameRaw) ?? id;
    out.push({ id, name });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isRecord(item)) continue;
      push(item.id, item.name);
    }
    return out.slice(0, 100);
  }

  if (!isRecord(raw)) return out;

  const dataField = raw.data;
  if (Array.isArray(dataField)) {
    for (const item of dataField) {
      if (!isRecord(item)) continue;
      push(item.id, item.display_name ?? item.name);
    }
  }

  const modelsField = raw.models;
  if (Array.isArray(modelsField)) {
    for (const item of modelsField) {
      if (!isRecord(item)) continue;
      push(item.name ?? item.id, item.displayName ?? item.name);
    }
  }

  return out.slice(0, 100);
}

function toOpenAIModels(models: NormalizedModel[]) {
  return {
    object: "list",
    data: models.map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "provider",
      name: m.name,
    })),
  };
}

function toAnthropicModels(models: NormalizedModel[]) {
  return {
    data: models.map((m) => ({
      type: "model",
      id: m.id,
      display_name: m.name,
      created_at: "1970-01-01T00:00:00Z",
    })),
    first_id: models[0]?.id ?? null,
    last_id: models.length > 0 ? models[models.length - 1].id : null,
    has_more: false,
  };
}

function toGeminiModels(models: NormalizedModel[]) {
  return {
    models: models.map((m) => ({
      name: m.id,
      displayName: m.name,
      supportedGenerationMethods: ["generateContent"],
    })),
  };
}

function buildProbeTarget(input: {
  format: ProbeFormat;
  request: Request;
  base_url: string;
  api_key: string;
}): { urls: string[]; headers: Record<string, string> } {
  const baseUrl = trimSlash(input.base_url);
  const url = new URL(input.request.url);
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (input.format === "anthropic") {
    const apiKey = input.request.headers.get("x-api-key")?.trim() || input.api_key;
    const anthropicVersion =
      input.request.headers.get("anthropic-version")?.trim() || "2023-06-01";
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = anthropicVersion;

    const endpoint = /\/v\d+$/i.test(baseUrl)
      ? `${baseUrl}/models`
      : `${baseUrl}/v1/models`;
    return { urls: [endpoint], headers };
  }

  if (input.format === "gemini") {
    const keyFromQuery = url.searchParams.get("key")?.trim();
    const keyFromHeader = input.request.headers.get("x-goog-api-key")?.trim();
    const key = keyFromHeader || keyFromQuery || input.api_key;
    if (keyFromHeader) headers["x-goog-api-key"] = keyFromHeader;

    const endpoint = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
    const endpointUrl = new URL(endpoint);
    if (key) endpointUrl.searchParams.set("key", key);

    const urls = [endpointUrl.toString()];
    const hasExplicitModelsPath = /\/models$/i.test(baseUrl);
    const hasVersionSuffix = /\/v\d+[a-z0-9-]*$/i.test(baseUrl);
    if (!hasExplicitModelsPath && !hasVersionSuffix) {
      const fallbackUrl = new URL(`${baseUrl}/v1/models`);
      if (key) fallbackUrl.searchParams.set("key", key);
      urls.push(fallbackUrl.toString());
    }
    return { urls, headers };
  }

  if (input.api_key) headers.Authorization = `Bearer ${input.api_key}`;
  const urls = [`${baseUrl}/models`];
  if (!/\/v\d+$/i.test(baseUrl)) {
    urls.push(`${baseUrl}/v1/models`);
  }
  return { urls, headers };
}

function formatProbeResponse(format: ProbeFormat, models: NormalizedModel[]) {
  if (format === "anthropic") return toAnthropicModels(models);
  if (format === "gemini") return toGeminiModels(models);
  return toOpenAIModels(models);
}

// POST /api/providers/probe - Probe endpoint and return model list in provider-specific format
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { base_url, api_key } = ProbeSchema.parse(body);
    const format = detectProbeFormat(request);

    const target = buildProbeTarget({
      format,
      request,
      base_url,
      api_key,
    });

    let payload: unknown | null = null;
    let lastStatus = 502;
    let lastDetails = "";

    for (const candidateUrl of target.urls) {
      const res = await fetch(candidateUrl, {
        headers: target.headers,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      });

      const text = await res.text().catch(() => "");
      if (text.length > 512 * 1024) {
        return NextResponse.json(
          { ok: false, error: { code: "PROBE_FAILED", message: "Response too large" } },
          { status: 502 }
        );
      }

      if (!res.ok) {
        lastStatus = res.status;
        lastDetails = text.slice(0, 1000);
        continue;
      }

      try {
        payload = JSON.parse(text);
        break;
      } catch {
        lastStatus = res.status || 502;
        lastDetails = text.slice(0, 1000);
      }
    }

    if (!payload) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "PROBE_FAILED",
            message: `Endpoint returned ${lastStatus}`,
            details: lastDetails,
          },
        },
        { status: 502 }
      );
    }

    const models = extractModels(payload);
    const formatted = formatProbeResponse(format, models);
    return NextResponse.json(formatted, {
      headers: { "x-probe-format": format },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        {
          ok: false,
          error: { code: "VALIDATION", message: err.errors.map((e) => e.message).join("; ") },
        },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "PROBE_ERROR", message: "Failed to connect to endpoint" } },
      { status: 502 }
    );
  }
}
