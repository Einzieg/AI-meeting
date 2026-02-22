"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

type ModelInfo = { id: string; name: string; context_window?: number; max_output_tokens?: number };
type ProviderInfo = { id: string; name: string; configured: boolean; models: ModelInfo[]; is_custom?: boolean };
type CustomProviderConfig = { id: string; name: string; base_url: string; api_key: string; models: ModelInfo[]; created_at: string };
type ProviderFormData = Omit<CustomProviderConfig, "id" | "created_at">;

function ProviderForm({
  initial,
  onSave,
  onCancel,
  onDelete,
}: {
  initial?: CustomProviderConfig;
  onSave: (data: ProviderFormData) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>(initial?.models ?? []);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");

  const probe = async () => {
    if (!baseUrl) return;
    setProbeErr(null);
    setProbing(true);
    try {
      const res = await fetch("/api/providers/probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error?.message ?? "Probe failed");
      setModels(json.data);
    } catch (e) {
      setProbeErr((e as Error).message);
    } finally {
      setProbing(false);
    }
  };

  const addModel = () => {
    const id = newId.trim(), nm = newName.trim();
    if (!id) return;
    setModels((prev) => [...prev, { id, name: nm || id }]);
    setNewId("");
    setNewName("");
  };

  const submit = async () => {
    setSaving(true);
    const payload: ProviderFormData = { name, base_url: baseUrl, api_key: apiKey, models };
    // For edits: only send api_key if user actually entered a new one
    if (initial && !apiKey) delete (payload as Partial<ProviderFormData>).api_key;
    try { await onSave(payload); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">Name</label>
          <input className="input-field text-sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Provider" />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">Base URL</label>
          <input className="input-field text-sm" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" />
        </div>
      </div>

      <div>
        <label className="block text-xs text-text-muted mb-1">API Key</label>
        <div className="relative">
          <input className="input-field text-sm pr-16" type={showKey ? "text" : "password"} value={apiKey}
            onChange={(e) => setApiKey(e.target.value)} placeholder={initial ? "Leave empty to keep current key" : "Optional"} />
          <button type="button" onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-text-muted hover:text-text">
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-text-muted">Models ({models.length})</label>
          <button type="button" onClick={probe} disabled={!baseUrl || probing}
            className="btn btn-outline text-xs px-2 py-0.5">
            {probing ? "Fetching..." : "Fetch Models"}
          </button>
        </div>
        {probeErr && <p className="text-danger text-xs mb-1">{probeErr}</p>}

        <div className="bg-surface-2/50 rounded-lg border border-border p-2 space-y-1 max-h-60 overflow-y-auto">
          {models.map((m) => (
            <div key={m.id} className="flex items-center justify-between text-sm px-1">
              <span>{m.name} <span className="text-text-muted text-xs">({m.id})</span></span>
              <button type="button" onClick={() => setModels((prev) => prev.filter((x) => x.id !== m.id))}
                className="text-text-muted hover:text-danger text-xs">&times;</button>
            </div>
          ))}
          {models.length === 0 && <p className="text-text-muted text-xs px-1">No models. Use Fetch or add manually.</p>}
          <div className="flex gap-2 pt-1 border-t border-border">
            <input className="input-field text-xs flex-1" placeholder="model-id" value={newId} onChange={(e) => setNewId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addModel()} />
            <input className="input-field text-xs flex-1" placeholder="Display Name" value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addModel()} />
            <button type="button" onClick={addModel} className="btn btn-outline text-xs px-2 py-0.5">+</button>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        {onDelete && (
          <button type="button" disabled={saving}
            onClick={async () => { if (confirm("Delete this provider?")) { setSaving(true); await onDelete(); setSaving(false); } }}
            className="btn btn-danger text-xs mr-auto">Delete</button>
        )}
        <button type="button" onClick={onCancel} className="btn btn-outline text-xs" disabled={saving}>Cancel</button>
        <button type="button" onClick={submit} disabled={saving || !name || !baseUrl || models.length === 0}
          className="btn btn-primary text-xs">{saving ? "Saving..." : "Save"}</button>
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const [builtIn, setBuiltIn] = useState<ProviderInfo[]>([]);
  const [custom, setCustom] = useState<CustomProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, cRes] = await Promise.all([fetch("/api/providers"), fetch("/api/providers/custom")]);
      const pJson = await pRes.json();
      const cJson = await cRes.json();
      if (pJson.ok) setBuiltIn((pJson.data as ProviderInfo[]).filter((p) => !p.is_custom));
      if (cJson.ok) setCustom(cJson.data as CustomProviderConfig[]);
    } catch { setError("Failed to load providers"); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const create = async (data: ProviderFormData) => {
    const res = await fetch("/api/providers/custom", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error?.message ?? "Create failed");
    setExpanded(null);
    load();
  };

  const update = async (id: string, data: ProviderFormData) => {
    const res = await fetch(`/api/providers/custom/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error?.message ?? "Update failed");
    setExpanded(null);
    load();
  };

  const remove = async (id: string) => {
    const res = await fetch(`/api/providers/custom/${id}`, { method: "DELETE" });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error?.message ?? "Delete failed");
    setExpanded(null);
    load();
  };

  return (
    <main className="min-h-screen p-6 max-w-3xl mx-auto">
      <header className="mb-8">
        <button onClick={() => router.push("/")} className="btn btn-outline mb-4 text-sm">&larr; Back</button>
        <h1 className="text-2xl font-bold">Provider Settings</h1>
        <p className="text-text-secondary text-sm mt-1">Manage LLM providers and custom OpenAI-compatible endpoints</p>
      </header>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      {/* Built-in Providers */}
      <section className="card mb-6">
        <label className="text-sm font-medium mb-3 block">Built-in Providers</label>
        {loading ? (
          <p className="text-text-muted text-sm animate-pulse">Loading...</p>
        ) : (
          <div className="space-y-2">
            {builtIn.map((p) => (
              <div key={p.id} className="flex items-center justify-between p-2 rounded-lg border border-border">
                <div>
                  <span className="text-sm font-medium">{p.name}</span>
                  <span className="text-text-muted text-xs ml-2">{p.models.length} models</span>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${
                  p.configured ? "bg-success/20 text-success" : "bg-warning/20 text-warning"
                }`}>
                  {p.configured ? "Configured" : "Not Configured"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Custom Providers */}
      <section className="card mb-6">
        <div className="flex items-center justify-between mb-4">
          <label className="text-sm font-medium">Custom Providers ({custom.length})</label>
          <button onClick={() => setExpanded(expanded === "__new" ? null : "__new")}
            className="btn btn-outline text-xs px-3 py-1" disabled={loading}>
            {expanded === "__new" ? "Cancel" : "+ Add Provider"}
          </button>
        </div>

        {expanded === "__new" && (
          <div className="border border-border rounded-lg p-3 mb-3 bg-surface-2/50">
            <p className="text-sm font-medium mb-3">New Provider (OpenAI Compatible)</p>
            <ProviderForm onSave={create} onCancel={() => setExpanded(null)} />
          </div>
        )}

        <div className="space-y-2">
          {custom.map((p) => (
            <div key={p.id} className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 p-3 cursor-pointer hover:bg-surface-2 transition-colors"
                onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                <span className="text-sm font-medium flex-1">{p.name}</span>
                <span className="text-text-muted text-xs truncate max-w-[200px]">{p.base_url}</span>
                <span className="text-text-muted text-xs">{p.models.length} models</span>
                <span className="text-text-muted text-xs">{expanded === p.id ? "\u25B2" : "\u25BC"}</span>
              </div>
              {expanded === p.id && (
                <div className="border-t border-border p-3 bg-surface-2/50">
                  <ProviderForm initial={p} onSave={(data) => update(p.id, data)}
                    onCancel={() => setExpanded(null)} onDelete={() => remove(p.id)} />
                </div>
              )}
            </div>
          ))}
          {!loading && custom.length === 0 && expanded !== "__new" && (
            <p className="text-text-muted text-xs text-center py-4">No custom providers. Click &quot;+ Add Provider&quot; to add one.</p>
          )}
        </div>
      </section>
    </main>
  );
}
