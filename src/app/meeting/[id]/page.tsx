"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMeetingStore, type MeetingDetail } from "@/store/meeting-store";
import { useMeetingStream } from "@/hooks/use-meeting-stream";
import type { Message, Vote } from "@/lib/domain/models";

const AGENT_COLORS: Record<string, string> = {
  "agent-1": "#6366f1", "agent-2": "#ec4899", "agent-3": "#14b8a6", "agent-4": "#f59e0b",
  "agent-5": "#8b5cf6", "agent-6": "#06b6d4", "agent-7": "#f97316", "agent-8": "#84cc16",
};

function agentColor(id: string): string {
  return AGENT_COLORS[id] ?? "#6366f1";
}

function agentDisplayName(meeting: MeetingDetail | null, agentId: string): string {
  const agent = meeting?.config?.agents?.find((a) => a.id === agentId);
  return agent?.display_name ?? agentId;
}

function stateLabel(state: string): { text: string; color: string } {
  switch (state) {
    case "DRAFT": return { text: "Draft", color: "text-text-muted" };
    case "RUNNING_DISCUSSION": return { text: "Discussing", color: "text-primary" };
    case "RUNNING_VOTE": return { text: "Voting", color: "text-warning" };
    case "FINISHED_ACCEPTED": return { text: "Accepted", color: "text-success" };
    case "FINISHED_ABORTED": return { text: "Aborted", color: "text-danger" };
    default: return { text: state, color: "text-text-muted" };
  }
}

// ── Message Bubble ──
function MessageBubble({ msg, meeting }: { msg: Message; meeting: MeetingDetail | null }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end mb-3">
        <div className="max-w-[75%] bg-primary/20 border border-primary/30 rounded-lg px-4 py-2">
          <p className="text-xs text-primary mb-1 font-medium">You</p>
          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
        </div>
      </div>
    );
  }

  if (msg.role === "system") {
    return (
      <div className="flex justify-center mb-3">
        <div className="max-w-[85%] bg-surface-2 border border-border rounded-lg px-4 py-2 text-center">
          <p className="text-xs text-text-muted mb-1">{msg.system_id ?? "system"} &middot; Round {msg.meta.round}</p>
          <p className="text-sm text-text-secondary whitespace-pre-wrap">{msg.content}</p>
        </div>
      </div>
    );
  }

  // agent
  const color = agentColor(msg.agent_id ?? "");
  const name = agentDisplayName(meeting, msg.agent_id ?? "");
  return (
    <div className="flex mb-3 gap-2">
      <div className="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-xs font-bold text-white mt-0.5"
        style={{ background: color }}>
        {name.charAt(0).toUpperCase()}
      </div>
      <div className="max-w-[75%]">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-xs font-medium" style={{ color }}>{name}</span>
          <span className="text-[10px] text-text-muted">R{msg.meta.round}</span>
        </div>
        <div className="bg-surface-2 border border-border rounded-lg px-3 py-2">
          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
        </div>
        {msg.meta.latency_ms && (
          <p className="text-[10px] text-text-muted mt-0.5">{msg.meta.latency_ms}ms</p>
        )}
      </div>
    </div>
  );
}

// ── Vote Sidebar Item ──
function VoteItem({ vote, meeting }: { vote: Vote; meeting: MeetingDetail | null }) {
  const name = agentDisplayName(meeting, vote.voter_agent_id);
  const color = agentColor(vote.voter_agent_id);
  return (
    <div className="flex items-center gap-2 py-1.5 border-b border-border/50 last:border-0">
      <div className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white"
        style={{ background: color }}>
        {name.charAt(0).toUpperCase()}
      </div>
      <span className="text-xs flex-1 truncate">{name}</span>
      <span className={`text-xs font-mono font-bold ${vote.pass ? "text-success" : "text-danger"}`}>
        {vote.score}
      </span>
    </div>
  );
}

export default function MeetingPage() {
  const params = useParams();
  const router = useRouter();
  const meetingId = params.id as string;

  const { meeting, messages, votes, isConnected, setMeeting, setMessages, setVotes } = useMeetingStore();
  useMeetingStream(meeting?.state?.startsWith("RUNNING") ? meetingId : null);

  const [loading, setLoading] = useState(true);
  const [userInput, setUserInput] = useState("");
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Fetch initial data
  const fetchMeeting = useCallback(async () => {
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
  }, [meetingId, setMeeting, setMessages, setVotes]);

  useEffect(() => { fetchMeeting(); }, [fetchMeeting]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Redirect to result page when finished (skip during initial load)
  useEffect(() => {
    if (!loading && meeting?.state?.startsWith("FINISHED")) {
      router.replace(`/meeting/${meetingId}/result`);
    }
  }, [loading, meeting?.state, meetingId, router]);

  const handleStart = async () => {
    const res = await fetch(`/api/meetings/${meetingId}/start`, { method: "POST" });
    const json = await res.json();
    if (json.ok) {
      setMeeting({ ...meeting!, state: "RUNNING_DISCUSSION" });
    }
  };

  const handleSendMessage = async () => {
    if (!userInput.trim() || sending) return;
    setSending(true);
    try {
      await fetch(`/api/meetings/${meetingId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: userInput.trim() }),
      });
      setUserInput("");
    } catch { /* ignore */ }
    setSending(false);
  };

  const handleAbort = async () => {
    await fetch(`/api/meetings/${meetingId}/abort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "User aborted" }),
    });
    router.push(`/meeting/${meetingId}/result`);
  };

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-text-muted animate-pulse">Loading meeting...</p>
      </main>
    );
  }

  if (!meeting) {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center gap-4">
        <p className="text-danger">Meeting not found</p>
        <button onClick={() => router.push("/")} className="btn btn-outline">Back to Home</button>
      </main>
    );
  }

  const sl = stateLabel(meeting.state);
  const isRunning = meeting.state.startsWith("RUNNING");
  const isDraft = meeting.state === "DRAFT";

  return (
    <main className="h-screen flex flex-col">
      {/* Header */}
      <header className="border-b border-border px-4 py-3 flex items-center gap-4 shrink-0 bg-surface">
        <button onClick={() => router.push("/")} className="text-text-muted hover:text-text text-sm">&larr;</button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-bold truncate">{meeting.topic}</h1>
          <div className="flex items-center gap-2 text-xs">
            <span className={sl.color}>{sl.text}</span>
            <span className="text-text-muted">&middot; Round {meeting.round}</span>
            {isConnected && <span className="text-success">&#9679; Live</span>}
          </div>
        </div>
        {isDraft && (
          <button onClick={handleStart} className="btn btn-primary text-sm">Start Discussion</button>
        )}
        {isRunning && (
          <button onClick={handleAbort} className="btn btn-danger text-sm">Abort</button>
        )}
      </header>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* Messages */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 && isDraft && (
              <div className="flex items-center justify-center h-full text-text-muted text-sm">
                Press &quot;Start Discussion&quot; to begin
              </div>
            )}
            {messages.length === 0 && isRunning && (
              <div className="flex items-center justify-center h-full text-text-muted text-sm animate-pulse">
                Waiting for agents...
              </div>
            )}
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} meeting={meeting} />
            ))}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          {isRunning && (
            <div className="border-t border-border p-3 bg-surface">
              <div className="flex gap-2">
                <input
                  className="input-field flex-1"
                  placeholder="Send a steering message..."
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendMessage(); } }}
                  disabled={sending}
                />
                <button onClick={handleSendMessage} disabled={sending || !userInput.trim()}
                  className="btn btn-primary shrink-0">
                  {sending ? "..." : "Send"}
                </button>
              </div>
              {meeting.state === "RUNNING_VOTE" && (
                <p className="text-xs text-warning mt-1">Voting in progress. Your message will interrupt the vote.</p>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside className="w-56 border-l border-border bg-surface shrink-0 overflow-y-auto hidden md:block">
          <div className="p-3">
            <h3 className="text-xs font-medium text-text-muted mb-2 uppercase tracking-wider">Agents</h3>
            <div className="space-y-1.5">
              {meeting.config.agents.map((agent) => (
                <div key={agent.id} className="flex items-center gap-2">
                  <div className="w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white"
                    style={{ background: agentColor(agent.id) }}>
                    {agent.display_name.charAt(0).toUpperCase()}
                  </div>
                  <span className="text-xs truncate">{agent.display_name}</span>
                </div>
              ))}
            </div>
          </div>

          {votes.length > 0 && (
            <div className="p-3 border-t border-border">
              <h3 className="text-xs font-medium text-text-muted mb-2 uppercase tracking-wider">Latest Votes</h3>
              {votes.slice(-meeting.config.agents.length).map((vote) => (
                <VoteItem key={vote.id} vote={vote} meeting={meeting} />
              ))}
            </div>
          )}

          <div className="p-3 border-t border-border">
            <h3 className="text-xs font-medium text-text-muted mb-2 uppercase tracking-wider">Config</h3>
            <div className="text-xs text-text-secondary space-y-1">
              <p>Mode: {meeting.effective_discussion_mode ?? meeting.config.discussion.mode}</p>
              <p>Threshold: {meeting.config.threshold.avg_score_threshold}</p>
              <p>Rounds: {meeting.config.threshold.min_rounds}-{meeting.config.threshold.max_rounds}</p>
            </div>
          </div>
        </aside>
      </div>
    </main>
  );
}
