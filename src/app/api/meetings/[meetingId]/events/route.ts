import { NextRequest } from "next/server";
import { getStore, addSseListener } from "@/lib/runtime";

type Params = { params: Promise<{ meetingId: string }> };

// GET /api/meetings/[meetingId]/events - SSE stream
export async function GET(req: NextRequest, { params }: Params) {
  const { meetingId } = await params;
  const store = getStore();

  const meeting = await store.getMeeting(meetingId);
  if (!meeting) {
    return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: "Meeting not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Get Last-Event-ID for replay
  const lastEventId = req.headers.get("Last-Event-ID");
  const afterId = lastEventId ? parseInt(lastEventId, 10) : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Replay missed events
      if (afterId !== undefined && !isNaN(afterId)) {
        const { items } = await store.listEvents({ meeting_id: meetingId, after: afterId });
        for (const event of items) {
          const data = JSON.stringify({ type: event.type, payload: event.payload, at: event.at });
          controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${data}\n\n`));
        }
      }

      // Live events
      const unsubscribe = addSseListener(meetingId, (event) => {
        try {
          const data = JSON.stringify({ type: event.type, payload: event.payload, at: event.at });
          controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${data}\n\n`));
        } catch {
          // Stream closed
        }
      });

      // Heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      // Cleanup on abort
      req.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
