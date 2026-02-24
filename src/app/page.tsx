"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { MeetingState } from "@/lib/domain/models";
import { useT, type TFunction } from "@/hooks/use-t";
import { useUiStore } from "@/store/ui-store";

type MeetingItem = {
  id: string;
  topic: string;
  state: MeetingState;
  round: number;
  created_at: string;
  config: { agents: { id: string; display_name: string }[] };
};

function stateTag(state: MeetingState, t: TFunction) {
  const map: Record<string, { text: string; cls: string }> = {
    DRAFT: { text: t("meeting.state.draft"), cls: "bg-surface-2 text-text-muted" },
    RUNNING_DISCUSSION: { text: t("meeting.state.discussing"), cls: "bg-primary/20 text-primary" },
    RUNNING_VOTE: { text: t("meeting.state.voting"), cls: "bg-warning/20 text-warning" },
    FINISHED_ACCEPTED: { text: t("meeting.state.accepted"), cls: "bg-success/20 text-success" },
    FINISHED_ABORTED: { text: t("meeting.state.aborted"), cls: "bg-danger/20 text-danger" },
  };
  const s = map[state] ?? { text: state, cls: "bg-surface-2 text-text-muted" };
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${s.cls}`}>{s.text}</span>;
}

export default function Home() {
  const router = useRouter();
  const t = useT();
  const locale = useUiStore((s) => s.locale);
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
          <h1 className="text-2xl font-bold">{t("app.title")}</h1>
          <p className="text-text-secondary text-sm">{t("app.tagline")}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => router.push("/settings")} className="btn btn-outline">
            {t("nav.settings")}
          </button>
          <button onClick={() => router.push("/new")} className="btn btn-primary">
            {t("home.new_meeting")}
          </button>
        </div>
      </header>

      {loading && <p className="text-text-muted text-center animate-pulse py-12">{t("common.loading")}</p>}

      {!loading && meetings.length === 0 && (
        <div className="card text-center py-12">
          <p className="text-text-muted mb-4">{t("home.no_meetings")}</p>
          <button onClick={() => router.push("/new")} className="btn btn-primary">{t("home.create_first_meeting")}</button>
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
                  {stateTag(m.state, t)}
                </div>
                <div className="flex items-center gap-3 text-xs text-text-muted">
                  <span>{t("home.agents_count", { n: m.config.agents.length })}</span>
                  <span>{t("common.round", { n: m.round })}</span>
                  <span>{new Date(m.created_at).toLocaleDateString(locale)}</span>
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
