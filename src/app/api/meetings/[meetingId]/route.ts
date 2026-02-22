import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/runtime";

type Params = { params: Promise<{ meetingId: string }> };

// GET /api/meetings/[meetingId]
export async function GET(_req: NextRequest, { params }: Params) {
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

    // Also fetch messages and votes
    const [messagesResult, votesResult] = await Promise.all([
      store.listMessages({ meeting_id: meetingId }),
      store.listVotes({ meeting_id: meetingId }),
    ]);

    return NextResponse.json({
      ok: true,
      data: {
        ...meeting,
        messages: messagesResult.items,
        votes: votesResult.items,
      },
    });
  } catch (err) {
    console.error("[API] GET /api/meetings/:id error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}
