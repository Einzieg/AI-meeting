import { NextResponse } from "next/server";
import { getLLMRegistry } from "@/lib/runtime";

// GET /api/providers - List available providers and their models
export async function GET() {
  try {
    const registry = getLLMRegistry();
    const providers = registry.listProviders();
    return NextResponse.json({ ok: true, data: providers });
  } catch (err) {
    console.error("[API] GET /api/providers error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}
