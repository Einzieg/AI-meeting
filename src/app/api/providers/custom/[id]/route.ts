import { NextResponse } from "next/server";
import { z } from "zod";
import { getLLMRegistry } from "@/lib/runtime";
import type { CustomProviderConfig } from "@/lib/llm/types";

const ModelInfoSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  context_window: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
});

const UpdateCustomProviderSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  base_url: z.string().url().optional(),
  api_key: z.string().optional(),
  models: z.array(ModelInfoSchema).min(1).max(50).optional(),
});

function maskKey(config: CustomProviderConfig) {
  const key = config.api_key;
  return {
    ...config,
    api_key: key.length > 8 ? `${key.slice(0, 4)}${"*".repeat(key.length - 8)}${key.slice(-4)}` : key ? "*".repeat(key.length) : "",
  };
}

type RouteParams = { params: Promise<{ id: string }> };

// GET /api/providers/custom/:id (key masked)
export async function GET(_req: Request, { params }: RouteParams) {
  const { id } = await params;
  const registry = getLLMRegistry();
  const config = registry.getCustomConfig(id);
  if (!config) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: `Custom provider "${id}" not found` } },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true, data: maskKey(config) });
}

// PUT /api/providers/custom/:id
export async function PUT(request: Request, { params }: RouteParams) {
  try {
    const { id } = await params;
    const registry = getLLMRegistry();
    const existing = registry.getCustomConfig(id);
    if (!existing) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: `Custom provider "${id}" not found` } },
        { status: 404 }
      );
    }

    const body = await request.json();
    const patch = UpdateCustomProviderSchema.parse(body);

    // If api_key not provided in patch, keep existing key
    const updated: CustomProviderConfig = {
      ...existing,
      ...patch,
      api_key: patch.api_key !== undefined ? patch.api_key : existing.api_key,
      id: existing.id,
      created_at: existing.created_at,
    };

    registry.updateCustom(updated);
    return NextResponse.json({ ok: true, data: maskKey(updated) });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION", message: err.errors.map((e) => e.message).join("; ") } },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: "Failed to update provider" } },
      { status: 500 }
    );
  }
}

// DELETE /api/providers/custom/:id
export async function DELETE(_req: Request, { params }: RouteParams) {
  const { id } = await params;
  const registry = getLLMRegistry();
  const removed = registry.unregisterCustom(id);
  if (!removed) {
    return NextResponse.json(
      { ok: false, error: { code: "NOT_FOUND", message: `Custom provider "${id}" not found` } },
      { status: 404 }
    );
  }
  return NextResponse.json({ ok: true });
}
