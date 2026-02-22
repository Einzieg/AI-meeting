import { NextRequest, NextResponse } from "next/server";
import { getStore, getRunner } from "@/lib/runtime";

type Params = { params: Promise<{ meetingId: string }> };

// POST /api/meetings/[meetingId]/abort
export async function POST(req: NextRequest, { params }: Params) {
  try {
    const { meetingId } = await params;
    const body = await req.json().catch(() => ({}));
    const reason = (body as Record<string, unknown>).reason as string | undefined;

    const store = getStore();
    const meeting = await store.getMeeting(meetingId);
    if (!meeting) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Meeting not found" } },
        { status: 404 }
      );
    }
    if (meeting.state.startsWith("FINISHED")) {
      return NextResponse.json(
        { ok: false, error: { code: "CONFLICT", message: "Meeting already finished" } },
        { status: 409 }
      );
    }

    const runner = getRunner(meetingId);
    runner?.stop();

    await store.updateMeeting(meetingId, {
      state: "FINISHED_ABORTED",
      result: {
        accepted: false,
        concluded_at: new Date().toISOString(),
        reason: reason ?? "Manually aborted by user",
      },
    });

    const updated = await store.getMeeting(meetingId);
    return NextResponse.json({ ok: true, data: updated });
  } catch (err) {
    console.error("[API] POST /api/meetings/:id/abort error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}
