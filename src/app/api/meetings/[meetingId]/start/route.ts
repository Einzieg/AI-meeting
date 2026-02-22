import { NextRequest, NextResponse } from "next/server";
import { getStore, createRunner, getRunner } from "@/lib/runtime";

type Params = { params: Promise<{ meetingId: string }> };

// POST /api/meetings/[meetingId]/start
export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const { meetingId } = await params;
    const store = getStore();
    const meeting = await store.getMeeting(meetingId);

    if (!meeting) {
      return NextResponse.json(
        { ok: false, error: { code: "NOT_FOUND", message: "Meeting not found" } },
        { status: 404 }
      );
    }
    if (meeting.state !== "DRAFT") {
      return NextResponse.json(
        { ok: false, error: { code: "CONFLICT", message: `Meeting is in ${meeting.state} state, cannot start` } },
        { status: 409 }
      );
    }

    // Check if runner already exists
    if (getRunner(meetingId)) {
      return NextResponse.json(
        { ok: false, error: { code: "CONFLICT", message: "Meeting runner already exists" } },
        { status: 409 }
      );
    }

    const runner = createRunner(meetingId);
    // Start async — don't await
    runner.start(meetingId).catch((err) => {
      console.error("[API] Runner failed:", err);
    });

    return NextResponse.json({ ok: true, data: { meeting_id: meetingId, started: true } });
  } catch (err) {
    console.error("[API] POST /api/meetings/:id/start error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}
