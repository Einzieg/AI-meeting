import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/runtime";
import { buildMeetingReportMarkdown } from "@/lib/orchestrator/meeting-report";

type Params = { params: Promise<{ meetingId: string }> };

function extractFinalDocument(summaryJson: unknown): string | null {
  if (!summaryJson || typeof summaryJson !== "object") return null;
  const maybe = (summaryJson as Record<string, unknown>).final_document_markdown;
  return typeof maybe === "string" && maybe.trim().length > 0 ? maybe : null;
}

// GET /api/meetings/[meetingId]/report - Get meeting report markdown (optionally as attachment)
export async function GET(req: NextRequest, { params }: Params) {
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

    const [messagesResult, votesResult] = await Promise.all([
      store.listMessages({ meeting_id: meetingId }),
      store.listVotes({ meeting_id: meetingId }),
    ]);

    const accepted = meeting.state === "FINISHED_ACCEPTED";
    const reason =
      meeting.result?.reason ??
      (accepted ? "Consensus reached" : "Meeting ended without accepted consensus");
    const concludedAt = meeting.result?.concluded_at ?? meeting.updated_at;

    const reportMarkdown =
      meeting.result?.summary_markdown ??
      buildMeetingReportMarkdown({
        meeting,
        messages: messagesResult.items,
        votes: votesResult.items,
        accepted,
        reason,
        concludedAt,
      });

    const finalDocumentMarkdown = extractFinalDocument(meeting.result?.summary_json);
    const kind = req.nextUrl.searchParams.get("kind") === "result" ? "result" : "report";
    const markdown =
      kind === "result" ? (finalDocumentMarkdown ?? reportMarkdown) : reportMarkdown;

    const download = req.nextUrl.searchParams.get("download") === "1";
    const safeId = meeting.id.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `meeting-${safeId}-${kind}.md`;

    return new Response(markdown, {
      status: 200,
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[API] GET /api/meetings/:id/report error:", err);
    return NextResponse.json(
      { ok: false, error: { code: "INTERNAL", message: (err as Error).message } },
      { status: 500 }
    );
  }
}
