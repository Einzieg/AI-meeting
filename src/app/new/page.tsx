"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { AgentConfigInput } from "@/lib/domain/config";
import type { ProviderInfo } from "@/lib/llm/types";
import { useT } from "@/hooks/use-t";

const AGENT_COLORS = [
  "bg-agent-1", "bg-agent-2", "bg-agent-3", "bg-agent-4",
  "bg-agent-5", "bg-agent-6", "bg-agent-7", "bg-agent-8",
];

const PRESETS: { label: string; prompt: string }[] = [
  { label: "Optimist", prompt: "You are an optimistic thinker. Focus on opportunities, positive outcomes, and constructive solutions." },
  { label: "Skeptic", prompt: "You are a critical thinker. Question assumptions, identify risks, and challenge weak arguments." },
  { label: "Creative", prompt: "You are a creative problem solver. Propose unconventional ideas, think laterally, and explore novel approaches." },
  { label: "Analyst", prompt: "You are a rigorous analyst. Focus on data, logic, evidence-based reasoning, and structured analysis." },
  { label: "Pragmatist", prompt: "You are a practical thinker. Focus on feasibility, implementation details, and real-world constraints." },
];

function defaultAgent(index: number, providers: ProviderInfo[]): AgentConfigInput {
  const preset = PRESETS[index % PRESETS.length];
  const defaultProvider = providers[0];
  const defaultModel = defaultProvider?.models[0];
  return {
    id: `agent-${index + 1}`,
    display_name: `${preset.label} #${index + 1}`,
    provider: defaultProvider?.id ?? "mock",
    model: defaultModel?.id ?? "mock-default",
    system_prompt: preset.prompt,
  };
}

export default function NewMeetingPage() {
  const router = useRouter();
  const t = useT();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [topic, setTopic] = useState("");
  const [agents, setAgents] = useState<AgentConfigInput[]>([]);
  const [mode, setMode] = useState<"auto" | "serial_turn" | "parallel_round">("auto");
  const [minRounds, setMinRounds] = useState(2);
  const [maxRounds, setMaxRounds] = useState(8);
  const [threshold, setThreshold] = useState(80);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgent, setExpandedAgent] = useState<number | null>(null);

  const loadProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/providers", { cache: "no-store" });
      const json = await res.json();
      if (!json.ok) return;

      const provs: ProviderInfo[] = json.data;
      setProviders(provs);
      setAgents((prev) => {
        // First load: initialize default agents.
        if (prev.length === 0) {
          return [
            defaultAgent(0, provs),
            defaultAgent(1, provs),
            defaultAgent(2, provs),
          ];
        }

        // Keep current agent setup, but fix stale provider/model selections.
        return prev.map((agent) => {
          const provider = provs.find((p) => p.id === agent.provider) ?? provs[0];
          if (!provider) return agent;
          const hasModel = provider.models.some((m) => m.id === agent.model);
          return {
            ...agent,
            provider: provider.id,
            model: hasModel ? agent.model : (provider.models[0]?.id ?? ""),
          };
        });
      });
    } catch {
      // ignore
    }
  }, []);

  // Fetch providers on mount, and refresh when window gets focus.
  useEffect(() => {
    loadProviders().catch(() => {
      // handled in loadProviders
    });

    const onFocus = () => {
      loadProviders().catch(() => {
        // handled in loadProviders
      });
    };

    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadProviders]);

  const modelsForProvider = (providerId: string) => {
    return providers.find((p) => p.id === providerId)?.models ?? [];
  };

  const addAgent = () => {
    if (agents.length >= 8) return;
    setAgents([...agents, defaultAgent(agents.length, providers)]);
  };

  const removeAgent = (idx: number) => {
    if (agents.length <= 3) return;
    setAgents(agents.filter((_, i) => i !== idx));
  };

  const updateAgent = (idx: number, patch: Partial<AgentConfigInput>) => {
    setAgents(agents.map((a, i) => {
      if (i !== idx) return a;
      const updated = { ...a, ...patch };
      // When provider changes, reset model to first available
      if (patch.provider && patch.provider !== a.provider) {
        const models = modelsForProvider(patch.provider);
        updated.model = models[0]?.id ?? "";
      }
      return updated;
    }));
  };

  // Apply provider+model to all agents at once
  const applyToAll = (providerId: string, modelId: string) => {
    setAgents(agents.map((a) => ({ ...a, provider: providerId, model: modelId })));
  };

  const handleSubmit = async () => {
    if (!topic.trim()) { setError(t("new.err_topic_required")); return; }
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch("/api/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          config: {
            agents,
            discussion: { mode },
            threshold: { min_rounds: minRounds, max_rounds: maxRounds, avg_score_threshold: threshold },
          },
        }),
      });
      const json = await res.json();
      if (!json.ok) { setError(json.error?.message ?? t("new.err_create_failed")); return; }
      router.push(`/meeting/${json.data.id}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <header className="mb-8">
        <button onClick={() => router.push("/")} className="btn btn-outline mb-4 text-sm">&larr; {t("common.back")}</button>
        <h1 className="text-2xl font-bold">{t("new.title")}</h1>
        <p className="text-text-secondary text-sm mt-1">{t("new.subtitle")}</p>
      </header>

      {/* Topic */}
      <section className="card mb-6">
        <label className="block text-sm font-medium mb-2">{t("new.topic")}</label>
        <textarea
          className="input-field min-h-[80px] resize-y"
          placeholder={t("new.topic_placeholder")}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          maxLength={2000}
        />
        <p className="text-text-muted text-xs mt-1 text-right">{topic.length}/2000</p>
      </section>

      {/* Global Provider/Model Quick-Set */}
      {providers.length > 0 && (
        <section className="card mb-6">
          <label className="text-sm font-medium mb-3 block">{t("new.quick_set_all_agents")}</label>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">{t("new.provider")}</label>
              <select className="input-field text-sm" value={agents[0]?.provider ?? ""}
                onChange={(e) => {
                  const pid = e.target.value;
                  const models = modelsForProvider(pid);
                  applyToAll(pid, models[0]?.id ?? "");
                }}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">{t("new.model")}</label>
              <select className="input-field text-sm" value={agents[0]?.model ?? ""}
                onChange={(e) => applyToAll(agents[0]?.provider ?? "", e.target.value)}>
                {modelsForProvider(agents[0]?.provider ?? "").map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="text-text-muted text-xs mt-2">{t("new.quick_help")}</p>
        </section>
      )}

      {/* Agents */}
      <section className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <label className="text-sm font-medium">{t("new.agents")} ({agents.length}/8)</label>
          <button onClick={addAgent} disabled={agents.length >= 8} className="btn btn-outline text-xs px-3 py-1">
            {t("new.add_agent")}
          </button>
        </div>
        <div className="space-y-2">
          {agents.map((agent, idx) => (
            <div key={idx} className="border border-border rounded-lg overflow-hidden">
              <div
                className="flex items-center gap-3 p-3 cursor-pointer hover:bg-surface-2 transition-colors"
                onClick={() => setExpandedAgent(expandedAgent === idx ? null : idx)}
              >
                <div className={`w-3 h-3 rounded-full ${AGENT_COLORS[idx]} shrink-0`} />
                <span className="text-sm font-medium flex-1">{agent.display_name || t("new.agent_fallback", { n: idx + 1 })}</span>
                <span className="text-text-muted text-xs">
                  {providers.find((p) => p.id === agent.provider)?.name ?? agent.provider}
                  {" / "}
                  {modelsForProvider(agent.provider).find((m) => m.id === agent.model)?.name ?? agent.model}
                </span>
                {agents.length > 3 && (
                  <button
                    onClick={(e) => { e.stopPropagation(); removeAgent(idx); }}
                    className="text-text-muted hover:text-danger text-sm px-1"
                  >&times;</button>
                )}
                <span className="text-text-muted text-xs">{expandedAgent === idx ? "▲" : "▼"}</span>
              </div>
              {expandedAgent === idx && (
                <div className="border-t border-border p-3 space-y-3 bg-surface-2/50">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-text-muted mb-1">{t("new.display_name")}</label>
                      <input className="input-field text-sm" value={agent.display_name}
                        onChange={(e) => updateAgent(idx, { display_name: e.target.value })} />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">{t("new.id")}</label>
                      <input className="input-field text-sm" value={agent.id}
                        onChange={(e) => updateAgent(idx, { id: e.target.value })} />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">{t("new.provider")}</label>
                      <select className="input-field text-sm" value={agent.provider}
                        onChange={(e) => updateAgent(idx, { provider: e.target.value })}>
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">{t("new.model")}</label>
                      <select className="input-field text-sm" value={agent.model}
                        onChange={(e) => updateAgent(idx, { model: e.target.value })}>
                        {modelsForProvider(agent.provider).map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                            {m.context_window ? ` (${Math.round(m.context_window / 1000)}k)` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-text-muted mb-1">{t("new.system_prompt")}</label>
                    <textarea className="input-field text-sm min-h-[60px] resize-y" value={agent.system_prompt}
                      onChange={(e) => updateAgent(idx, { system_prompt: e.target.value })} />
                  </div>
                  <div className="flex gap-1 flex-wrap">
                    {PRESETS.map((p) => (
                      <button key={p.label} className="text-xs px-2 py-0.5 rounded bg-surface-2 border border-border hover:border-primary text-text-secondary transition-colors"
                        onClick={() => updateAgent(idx, { display_name: `${p.label} #${idx + 1}`, system_prompt: p.prompt })}>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Settings */}
      <section className="card mb-6">
        <label className="text-sm font-medium mb-3 block">{t("new.settings")}</label>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-text-muted mb-1">{t("new.discussion_mode")}</label>
            <select className="input-field text-sm" value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}>
              <option value="auto">{t("new.mode_auto")}</option>
              <option value="serial_turn">{t("new.mode_serial_turn")}</option>
              <option value="parallel_round">{t("new.mode_parallel_round")}</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">{t("new.consensus_threshold", { n: threshold })}</label>
            <input type="range" min={0} max={100} value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-full accent-primary" />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">{t("new.min_rounds")}</label>
            <input type="number" className="input-field text-sm" min={0} max={maxRounds} value={minRounds}
              onChange={(e) => setMinRounds(Number(e.target.value))} />
          </div>
          <div>
            <label className="block text-xs text-text-muted mb-1">{t("new.max_rounds")}</label>
            <input type="number" className="input-field text-sm" min={minRounds} max={100} value={maxRounds}
              onChange={(e) => setMaxRounds(Number(e.target.value))} />
          </div>
        </div>
      </section>

      {/* Submit */}
      {error && <p className="text-danger text-sm mb-4">{error}</p>}
      <button onClick={handleSubmit} disabled={submitting || !topic.trim()}
        className="btn btn-primary w-full py-3 text-base">
        {submitting ? t("new.creating") : t("new.create_and_enter")}
      </button>
    </main>
  );
}
