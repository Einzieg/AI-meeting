import { NextResponse } from "next/server";
import { z } from "zod";

const ProbeSchema = z.object({
  base_url: z.string().url().refine((url) => {
    try {
      const u = new URL(url);
      return ["http:", "https:"].includes(u.protocol) && !u.hash && !u.username;
    } catch { return false; }
  }, "Only http/https URLs without fragments or credentials are allowed"),
  api_key: z.string().default(""),
});

// POST /api/providers/probe - Probe an OpenAI-compatible endpoint for available models
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { base_url, api_key } = ProbeSchema.parse(body);

    const url = `${base_url.replace(/\/$/, "")}/models`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (api_key) headers["Authorization"] = `Bearer ${api_key}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: { code: "PROBE_FAILED", message: `Endpoint returned ${res.status}` } },
        { status: 502 }
      );
    }

    const text = await res.text();
    if (text.length > 512 * 1024) {
      return NextResponse.json(
        { ok: false, error: { code: "PROBE_FAILED", message: "Response too large" } },
        { status: 502 }
      );
    }

    const data = JSON.parse(text);
    const rawModels: unknown[] = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : []);

    const models = rawModels
      .filter((m): m is { id: string; name?: string } => typeof m === "object" && m !== null && typeof (m as Record<string, unknown>).id === "string")
      .slice(0, 100)
      .map((m) => ({ id: m.id, name: m.name ?? m.id }));

    return NextResponse.json({ ok: true, data: models });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, error: { code: "VALIDATION", message: err.errors.map((e) => e.message).join("; ") } },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { ok: false, error: { code: "PROBE_ERROR", message: "Failed to connect to endpoint" } },
      { status: 502 }
    );
  }
}
