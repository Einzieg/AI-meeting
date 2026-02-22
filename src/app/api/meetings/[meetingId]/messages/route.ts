import { NextRequest, NextResponse } from "next/server";
import { getStore, getRunner } from "@/lib/runtime";

type Params = { params: Promise<{ meetingId: string }> };

// POST /api/meetings/[meetingId]/messages - User message
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { meetingId } = await params;
    const body = await req.json();
    const { content } = body;

    if (!content || typeof content !== "string" || content.trim().length === 0) {
      return NextResponse.json(
        { ok: false, error: { code: "BAD_REQUEST", message: "content is required" } },
        { status: 400 }
      );
    }

    const store = getStore();
    const meeting = await store.getMeeting(meetingId);
    if (!meeting) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Meeting not found" } },
        { status: 404 }
      );
    }
    if (!["RUNNING_DISCUSSION", "RUNNING_VOTE"].includes(meeting.state)) {
      return NextResponse.json(
        { ok: false, error: { code: "CONFLICT", message: `Cannot send messages in ${meeting.state} state` } },
        { status: 409 }
      );
    }

    const runner = getRunner(meetingId);
    if (!runner) {
      return NextResponse.json(
        { ok: false, error: { code: "CONFLICT", message: "No active runner for this meeting" } },
        { status: 409 }
      );
    }

    const message = await runner.handleUserMessage(meetingId, content.trim());
    const updatedMeeting = await store.getMeeting(meetingId);

    return NextResponse.json({ ok: true, data: { meeting: updatedMeeting, message } });
  } catch (err) {
    console.error("[API] POST /api/meetings/:id/messages error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}

// GET /api/meetings/[meetingId]/messages - List messages
export async function GET(req: NextRequest, { params }: Params) {
  try {
    const { meetingId } = await params;
    const url = new URL(req.url);
    const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
    const afterId = url.searchParams.get("after") ?? undefined;

    const store = getStore();
    const result = await store.listMessages({
      meeting_id: meetingId,
      limit,
      after_message_id: afterId,
    });

    return NextResponse.json({ ok: true, data: result });
  } catch (err) {
    console.error("[API] GET /api/meetings/:id/messages error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}
