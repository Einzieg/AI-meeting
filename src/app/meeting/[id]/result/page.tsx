"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import type { MeetingDetail } from "@/store/meeting-store";
import type { Message, Vote } from "@/lib/domain/models";
import { useT } from "@/hooks/use-t";
import { Markdown } from "@/components/markdown";

const AGENT_COLORS: Record<string, string> = {
  "agent-1": "#6366f1", "agent-2": "#ec4899", "agent-3": "#14b8a6", "agent-4": "#f59e0b",
  "agent-5": "#8b5cf6", "agent-6": "#06b6d4", "agent-7": "#f97316", "agent-8": "#84cc16",
};

export default function ResultPage() {
  const params = useParams();
  const router = useRouter();
  const meetingId = params.id as string;
  const t = useT();

  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [votes, setVotes] = useState<Vote[]>([]);
  const [loading, setLoading] = useState(true);

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
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, [meetingId]);

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
        <button onClick={() => router.push("/")} className="btn btn-outline">{t("common.back")}</button>
      </main>
    );
  }

  const accepted = meeting.result?.accepted;
  const agentMap = Object.fromEntries((meeting.config?.agents ?? []).map((a) => [a.id, a.display_name]));

  // Aggregate votes by agent
  const lastVoteSession = votes.length > 0 ? votes[votes.length - 1].vote_session_id : null;
  const finalVotes = lastVoteSession ? votes.filter((v) => v.vote_session_id === lastVoteSession) : [];
  const avgScore = finalVotes.length > 0
    ? Math.round(finalVotes.reduce((sum, v) => sum + v.score, 0) / finalVotes.length)
    : 0;

  const agentMessages = messages.filter((m) => m.role === "agent");
  const roundCount = meeting.round;

  return (
    <main className="min-h-screen p-6 max-w-4xl mx-auto">
      <button onClick={() => router.push("/")} className="btn btn-outline mb-6 text-sm">&larr; {t("common.back_home")}</button>

      {/* Status Banner */}
      <div className={`card mb-6 border-l-4 ${accepted ? "border-l-success" : "border-l-danger"}`}>
        <div className="flex items-center gap-3">
          <span className={`text-3xl ${accepted ? "text-success" : "text-danger"}`}>
            {accepted ? "✓" : "✗"}
          </span>
          <div>
            <h1 className="text-xl font-bold">
              {accepted ? t("result.consensus_reached") : t("result.meeting_ended")}
            </h1>
            <p className="text-text-secondary text-sm">
              {meeting.result?.reason ?? (accepted ? t("result.reason_consensus") : t("result.reason_aborted"))}
            </p>
          </div>
        </div>
      </div>

      {/* Topic */}
      <div className="card mb-6">
        <h2 className="text-sm font-medium text-text-muted mb-1">{t("result.topic")}</h2>
        <p className="text-base">{meeting.topic}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-4 mb-6">
        {[
          { label: t("result.stats.rounds"), value: roundCount },
          { label: t("result.stats.messages"), value: agentMessages.length },
          { label: t("result.stats.avg_score"), value: avgScore },
          { label: t("result.stats.agents"), value: meeting.config.agents.length },
        ].map(({ label, value }) => (
          <div key={label} className="card text-center">
            <p className="text-2xl font-bold">{value}</p>
            <p className="text-xs text-text-muted">{label}</p>
          </div>
        ))}
      </div>

      {/* Final Votes */}
      {finalVotes.length > 0 && (
        <div className="card mb-6">
          <h2 className="text-sm font-medium text-text-muted mb-3">{t("result.final_votes")}</h2>
          <div className="space-y-2">
            {finalVotes.map((vote) => (
              <div key={vote.id} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                <div className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white"
                  style={{ background: AGENT_COLORS[vote.voter_agent_id] ?? "#6366f1" }}>
                  {(agentMap[vote.voter_agent_id] ?? vote.voter_agent_id).charAt(0).toUpperCase()}
                </div>
                <span className="text-sm flex-1">{agentMap[vote.voter_agent_id] ?? vote.voter_agent_id}</span>
                <div className="w-32 h-2 bg-surface-2 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${vote.score >= 80 ? "bg-success" : vote.score >= 50 ? "bg-warning" : "bg-danger"}`}
                    style={{ width: `${vote.score}%` }} />
                </div>
                <span className={`text-sm font-mono font-bold w-8 text-right ${vote.pass ? "text-success" : "text-danger"}`}>
                  {vote.score}
                </span>
                {vote.rationale && (
                  <span className="text-xs text-text-muted truncate max-w-[200px]">{vote.rationale}</span>
                )}
              </div>
            ))}
          </div>
        </div>
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

      <button onClick={() => router.push("/new")} className="btn btn-primary w-full py-3">
        {t("result.start_new")}
      </button>
    </main>
  );
}
