"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MeetingDetail } from "@/store/meeting-store";
import type { Message, Vote } from "@/lib/domain/models";
import { useT } from "@/hooks/use-t";
import { Markdown } from "@/components/markdown";

const AGENT_COLORS: Record<string, string> = {
  "agent-1": "#6366f1",
  "agent-2": "#ec4899",
  "agent-3": "#14b8a6",
  "agent-4": "#f59e0b",
  "agent-5": "#8b5cf6",
  "agent-6": "#06b6d4",
  "agent-7": "#f97316",
  "agent-8": "#84cc16",
};

type ResultTab = "overview" | "result_doc" | "report" | "timeline";

function latestVoteSessionId(votes: Vote[]): string | null {
  if (votes.length === 0) return null;
  const latest = [...votes].sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1);
  return latest?.vote_session_id ?? null;
}

function agentName(meeting: MeetingDetail, agentId: string): string {
  const agent = meeting.config.agents.find((a) => a.id === agentId);
  return agent?.display_name ?? agentId;
}

function roleLabel(meeting: MeetingDetail, msg: Message, t: ReturnType<typeof useT>): string {
  if (msg.role === "user") return t("common.you");
  if (msg.role === "system") return msg.system_id ?? t("common.system");
  return agentName(meeting, msg.agent_id ?? "unknown");
}

function fallbackResultDoc(
  meeting: MeetingDetail,
  messages: Message[],
  votes: Vote[],
  avgScore: number
): string {
  return [
    "# Final Result Document",
    "",
    `## Topic`,
    meeting.topic,
    "",
    "## Decision",
    meeting.result?.accepted ? "Consensus accepted." : "Consensus was not accepted.",
    "",
    "## Final Metrics",
    `- Average score: ${avgScore}`,
    `- Messages: ${messages.length}`,
    `- Votes: ${votes.length}`,
    "",
    "## Reason",
    meeting.result?.reason ?? "N/A",
    "",
  ].join("\n");
}

function extractFinalDocumentMarkdown(result: MeetingDetail["result"]): string | null {
  const summaryJson = result?.summary_json;
  if (!summaryJson || typeof summaryJson !== "object") return null;
  const maybe = (summaryJson as Record<string, unknown>).final_document_markdown;
  return typeof maybe === "string" && maybe.trim().length > 0 ? maybe : null;
}

export default function ResultPage() {
  const params = useParams();
  const router = useRouter();
  const meetingId = params.id as string;
  const t = useT();

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<ResultTab>("overview");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/meetings/${meetingId}`);
        const json = await res.json();
        if (json.ok) {
          const { messages: msgs, votes: vts, ...mtg } = json.data;
          setMeeting(mtg as MeetingDetail);
          setMessages(msgs ?? []);
          setVotes(vts ?? []);
        }
      } catch {
        // ignore
      }
      setLoading(false);
    })();
  }, [meetingId]);

  const latestSessionId = useMemo(() => latestVoteSessionId(votes), [votes]);
  const finalVotes = useMemo(
    () => (latestSessionId ? votes.filter((v) => v.vote_session_id === latestSessionId) : []),
    [votes, latestSessionId]
  );
  const avgScore = useMemo(() => {
    if (finalVotes.length === 0) return 0;
    return Math.round(finalVotes.reduce((sum, v) => sum + v.score, 0) / finalVotes.length);
  }, [finalVotes]);

  const reportMarkdown = useMemo(() => meeting?.result?.summary_markdown ?? "", [meeting]);
  const finalDocumentMarkdown = useMemo(() => {
    if (!meeting) return "";
    const fromResult = extractFinalDocumentMarkdown(meeting.result);
    return fromResult ?? fallbackResultDoc(meeting, messages, votes, avgScore);
  }, [meeting, messages, votes, avgScore]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-text-muted animate-pulse">{t("result.loading")}</p>
      </main>
    );
  }

  if (!meeting) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-danger">{t("meeting.not_found")}</p>
        <button onClick={() => router.push("/")} className="btn btn-outline">
          {t("common.back")}
        </button>
      </main>
    );
  }

  const accepted = Boolean(meeting.result?.accepted);
  const tabs: Array<{ id: ResultTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "result_doc", label: "Final Result Doc" },
    { id: "report", label: "Review Report" },
    { id: "timeline", label: "Timeline" },
  ];

  return (
    <main className="min-h-screen p-6 max-w-5xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <button onClick={() => router.push("/")} className="btn btn-outline text-sm">
          &larr; {t("common.back_home")}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={`/api/meetings/${meetingId}/report?kind=result`}
            target="_blank"
            className="btn btn-outline text-sm"
          >
            Open Result .md
          </a>
          <a href={`/api/meetings/${meetingId}/report?kind=result&download=1`} className="btn btn-primary text-sm">
            Download Result .md
          </a>
          <a href={`/api/meetings/${meetingId}/report?kind=report&download=1`} className="btn btn-outline text-sm">
            Download Review Report
          </a>
        </div>
      </div>

      <div className={`card mb-6 border-l-4 ${accepted ? "border-l-success" : "border-l-danger"}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold">
              {accepted ? t("result.consensus_reached") : t("result.meeting_ended")}
            </h1>
            <p className="text-text-secondary text-sm mt-1">
              {meeting.result?.reason ??
                (accepted ? t("result.reason_consensus") : t("result.reason_aborted"))}
            </p>
          </div>
          <div
            className={`text-xs px-2 py-1 rounded-full font-medium ${
              accepted ? "bg-success/20 text-success" : "bg-danger/20 text-danger"
            }`}
          >
            {accepted ? "ACCEPTED" : "ABORTED"}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-6">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`text-sm px-3 py-1.5 rounded-lg border transition-colors ${
              activeTab === tab.id
                ? "border-primary bg-primary/15 text-primary"
                : "border-border text-text-secondary hover:border-border-hover"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && (
        <section className="space-y-6">
          <div className="card">
            <h2 className="text-sm font-medium text-text-muted mb-1">{t("result.topic")}</h2>
            <p className="text-base">{meeting.topic}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: t("result.stats.rounds"), value: meeting.round },
              { label: t("result.stats.messages"), value: messages.filter((m) => m.role === "agent").length },
              { label: t("result.stats.avg_score"), value: avgScore },
              { label: t("result.stats.agents"), value: meeting.config.agents.length },
            ].map(({ label, value }) => (
              <div key={label} className="card text-center">
                <p className="text-2xl font-bold">{value}</p>
                <p className="text-xs text-text-muted">{label}</p>
              </div>
            ))}
          </div>

          <div className="card">
            <h2 className="text-sm font-medium text-text-muted mb-3">Result Snapshot</h2>
            <ul className="text-sm text-text-secondary space-y-1">
              <li>Meeting ID: {meeting.id}</li>
              <li>Discussion Mode: {meeting.effective_discussion_mode ?? meeting.config.discussion.mode}</li>
              <li>Threshold: avg_score &gt;= {meeting.config.threshold.avg_score_threshold}</li>
              <li>
                Round Limits: {meeting.config.threshold.min_rounds}-{meeting.config.threshold.max_rounds}
              </li>
              <li>Concluded At: {meeting.result?.concluded_at ?? "-"}</li>
            </ul>
          </div>

          <div className="card">
            <h2 className="text-sm font-medium text-text-muted mb-3">{t("result.final_votes")}</h2>
            {finalVotes.length === 0 && (
              <p className="text-sm text-text-muted">No final vote session found.</p>
            )}
            {finalVotes.length > 0 && (
              <div className="space-y-2">
                {finalVotes.map((vote) => (
                  <div
                    key={vote.id}
                    className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0"
                  >
                    <div
                      className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white"
                      style={{ background: AGENT_COLORS[vote.voter_agent_id] ?? "#6366f1" }}
                    >
                      {agentName(meeting, vote.voter_agent_id).charAt(0).toUpperCase()}
                    </div>
                    <span className="text-sm w-36 shrink-0 truncate">
                      {agentName(meeting, vote.voter_agent_id)}
                    </span>
                    <div className="flex-1 h-2 bg-surface-2 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          vote.score >= 80 ? "bg-success" : vote.score >= 50 ? "bg-warning" : "bg-danger"
                        }`}
                        style={{ width: `${vote.score}%` }}
                      />
                    </div>
                    <span
                      className={`text-sm font-mono font-bold w-10 text-right ${
                        vote.pass ? "text-success" : "text-danger"
                      }`}
                    >
                      {vote.score}
                    </span>
                    <span className="text-xs text-text-muted w-56 truncate">{vote.rationale ?? "-"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      {/* Discussion Timeline (collapsed) */}
      <details className="card mb-6">
        <summary className="cursor-pointer text-sm font-medium text-text-muted">
          {t("result.full_discussion", { n: messages.length })}
        </summary>
        <div className="mt-3 space-y-2 max-h-[500px] overflow-y-auto">
          {messages.map((msg) => (
            <div key={msg.id} className="flex gap-2 py-1.5 border-b border-border/30 last:border-0">
              <span className="text-xs text-text-muted w-6 shrink-0">R{msg.meta.round}</span>
              <span className="text-xs font-medium w-24 shrink-0 truncate" style={{
                color: msg.role === "agent" ? (AGENT_COLORS[msg.agent_id ?? ""] ?? "#6366f1") :
                  msg.role === "user" ? "#6366f1" : "#71717a"
              }}>
                {msg.role === "agent" ? (agentMap[msg.agent_id ?? ""] ?? msg.agent_id) :
                  msg.role === "user" ? t("common.you") : (msg.system_id ?? t("common.system"))}
              </span>
              <span className="text-xs text-text-secondary flex-1 line-clamp-2">{msg.content}</span>
            </div>
          ))}
        </div>
      </details>

      {/* Summary */}
      {meeting.result?.summary_markdown && (
        <div className="card mb-6">
          <h2 className="text-sm font-medium text-text-muted mb-2">{t("result.summary")}</h2>
          <Markdown content={meeting.result.summary_markdown} className="text-sm text-text-secondary" />
        </div>
      )}

      {activeTab === "timeline" && (
        <section className="card">
          <h2 className="text-sm font-medium text-text-muted mb-3">
            {t("result.full_discussion", { n: messages.length })}
          </h2>
          <div className="space-y-3">
            {messages.map((msg) => (
              <div key={msg.id} className="border border-border rounded-lg p-3 bg-surface-2/40">
                <div className="flex items-center gap-2 mb-2 text-xs">
                  <span className="px-2 py-0.5 rounded bg-surface-2 border border-border">
                    R{msg.meta.round}
                  </span>
                  <span className="font-medium">{roleLabel(meeting, msg, t)}</span>
                  <span className="text-text-muted">{msg.created_at}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              </div>
            ))}
            {messages.length === 0 && <p className="text-sm text-text-muted">No messages found.</p>}
          </div>
        </section>
      )}
    </main>
  );
}
