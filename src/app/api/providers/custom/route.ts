import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { getLLMRegistry } from "@/lib/runtime";
import type { CustomProviderConfig } from "@/lib/llm/types";

const RESERVED_IDS = ["mock", "openai", "anthropic", "gemini"];

const ModelInfoSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

const CreateCustomProviderSchema = z.object({
  id: z.string().min(1).max(50).regex(/^[a-z0-9][a-z0-9_-]*$/).optional(),
  name: z.string().min(1).max(100),
  base_url: z.string().url(),
  api_key: z.string().default(""),
  models: z.array(ModelInfoSchema).min(1).max(50),
});

function maskKey(config: CustomProviderConfig) {
  const key = config.api_key;
  return {
    ...config,
    api_key: key.length > 8 ? `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}` : key ? "*".repeat(key.length) : "",
  };
}

// GET /api/providers/custom - List all custom provider configs (keys masked)
export async function GET() {
  const registry = getLLMRegistry();
  return NextResponse.json({ ok: true, data: registry.listCustomConfigs().map(maskKey) });
}

// POST /api/providers/custom - Create a new custom provider
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const parsed = CreateCustomProviderSchema.parse(body);

    const registry = getLLMRegistry();
    const id = parsed.id ?? `custom-${nanoid(8)}`;

    if (RESERVED_IDS.includes(id) || registry.hasProvider(id)) {
      return NextResponse.json(
        { ok: false, error: { code: "CONFLICT", message: `Provider ID "${id}" is reserved or already exists` } },
        { status: 409 }
      );
    }

    const config = {
      id,
      name: parsed.name,
      base_url: parsed.base_url,
      api_key: parsed.api_key,
      models: parsed.models,
      created_at: new Date().toISOString(),
    };

    registry.registerCustom(config);
    return NextResponse.json({ ok: true, data: maskKey(config) }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION", message: err.errors.map((e) => e.message).join("; ") } },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "Failed to create provider" } },
      { status: 500 }
    );
  }
}
