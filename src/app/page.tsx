"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MeetingState } from "@/lib/domain/models";

type MeetingItem = {
  id: string;
  topic: string;
  state: MeetingState;
  round: number;
  created_at: string;
  config: { agents: { id: string; display_name: string }[] };
};

function stateTag(state: MeetingState) {
  const map: Record<string, { text: string; cls: string }> = {
    DRAFT: { text: "Draft", cls: "bg-surface-2 text-text-muted" },
    RUNNING_DISCUSSION: { text: "Discussing", cls: "bg-primary/20 text-primary" },
    RUNNING_VOTE: { text: "Voting", cls: "bg-warning/20 text-warning" },
    FINISHED_ACCEPTED: { text: "Accepted", cls: "bg-success/20 text-success" },
    FINISHED_ABORTED: { text: "Aborted", cls: "bg-danger/20 text-danger" },
  };
  const s = map[state] ?? { text: state, cls: "bg-surface-2 text-text-muted" };
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${s.cls}`}>{s.text}</span>;
}

export default function Home() {
  const router = useRouter();
  const [meetings, setMeetings] = useState<MeetingItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/meetings?limit=50");
        const json = await res.json();
        if (json.ok) setMeetings(json.data.items ?? []);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  const navigateTo = (id: string, state: MeetingState) => {
    if (state.startsWith("FINISHED")) {
      router.push(`/meeting/${id}/result`);
    } else {
      router.push(`/meeting/${id}`);
    }
  };

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <header className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">AI Meeting</h1>
          <p className="text-text-secondary text-sm">Multi-AI multi-model discussion system</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => router.push("/settings")} className="btn btn-outline">
            Settings
          </button>
          <button onClick={() => router.push("/new")} className="btn btn-primary">
            + New Meeting
          </button>
        </div>
      </header>

      {loading && <p className="text-text-muted text-center animate-pulse py-12">Loading...</p>}

      {!loading && meetings.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-text-muted mb-4">No meetings yet</p>
          <button onClick={() => router.push("/new")} className="btn btn-primary">Create your first meeting</button>
        </div>
      )}

      {!loading && meetings.length > 0 && (
        <div className="space-y-2">
          {meetings.map((m) => (
            <div key={m.id}
              className="card flex items-center gap-4 cursor-pointer hover:border-border-hover transition-colors"
              onClick={() => navigateTo(m.id, m.state)}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <p className="text-sm font-medium truncate">{m.topic}</p>
                  {stateTag(m.state)}
                </div>
                <div className="flex items-center gap-3 text-xs text-text-muted">
                  <span>{m.config.agents.length} agents</span>
                  <span>Round {m.round}</span>
                  <span>{new Date(m.created_at).toLocaleDateString()}</span>
                </div>
              </div>
              <span className="text-text-muted text-sm">&rarr;</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
