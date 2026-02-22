import { NextRequest, NextResponse } from "next/server";
import { MeetingConfigSchema } from "@/lib/domain/config";
import { getStore } from "@/lib/runtime";

// POST /api/meetings - Create meeting
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { topic, config: rawConfig } = body;

    if (!topic || typeof topic !== "string" || topic.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_REQUEST", message: "topic is required" } },
        { status: 400 }
      );
    }

    const configResult = MeetingConfigSchema.safeParse(rawConfig);
    if (!configResult.success) {
      return NextResponse.json(
        { ok: false, error: { code: "UNPROCESSABLE_ENTITY", message: configResult.error.message, details: configResult.error.issues } },
        { status: 422 }
      );
    }

    const store = getStore();
    const meeting = await store.createMeeting({ topic: topic.trim(), config: configResult.data });

    return NextResponse.json({ ok: true, data: meeting }, { status: 201 });
  } catch (err) {
    console.error("[API] POST /api/meetings error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}

// GET /api/meetings - List meetings
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const cursor = url.searchParams.get("cursor") ?? undefined;

    const store = getStore();
    const result = await store.listMeetings({ limit, cursor });

    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    console.error("[API] GET /api/meetings error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}
