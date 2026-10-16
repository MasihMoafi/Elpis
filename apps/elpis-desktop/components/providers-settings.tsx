"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { providerFormId, type ProviderType } from "@/lib/provider-form";

import { useProviderUsage, type ConfiguredProvider as Configured, type Subscription } from "@/components/provider-usage";
// `gateway`: a route the engine serves through its own gateway (such as the Anthropic credits), not a server the user added.
type ProviderConfig = { id: string; name: string; baseUrl: string | null; wireApi: string; editable: boolean; gateway?: boolean; auth: { source: string; keySet: boolean; envKey: string | null } };
type ProviderConfigs = { application?: { scope: string; message: string; credentialClearMessage: string }; version: string | null; configPath: string | null; write: { available: boolean; reason?: string | null }; managed: { modelProvider: string | null }; providers: ProviderConfig[] };
type ProviderEdit = { id: string; type: ProviderType; name: string; baseUrl: string; existing: boolean; credential: "preserve" | "replace" | "clear"; secret: string };

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const State = ({ tone, children }: { tone: "ok" | "warn" | "off"; children: React.ReactNode }) => <span className={`provider-state ${tone}`}>{children}</span>;
function Card({ id, name, state, children }: { id: string; name: string; state: React.ReactNode; children: React.ReactNode }) {
  return <section className="provider-card settings-card" data-provider={id} aria-label={name}>
    <header className="flex flex-wrap items-center justify-between gap-2"><h3>{name}</h3>{state}</header>
    {children}
  </section>;
}
function ConfiguredList({ items, empty, config, onEdit }: { items: Configured[]; empty: string; config: ProviderConfigs | null; onEdit: (provider: ProviderConfig) => void }) {
  if (!items.length) return <p className="provider-note">{empty}</p>;
  return <ul className="grid gap-3">{items.map(item => {
    const provider = config?.providers.find(provider => provider.id === item.id);
    return <li key={item.id} className="text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-all"><span className="font-medium">{item.name}</span><span className="text-muted-foreground"> · {item.baseUrl ?? "no base URL"}</span></p>{provider && <Button variant="outline" size="sm" disabled={!config?.write?.available || !provider.editable} onClick={() => onEdit(provider)}>Edit {item.name}</Button>}</div>
      {(item.envKey || provider?.auth.keySet) && <p className="mt-1 text-xs text-muted-foreground">API key {item.keySet || provider?.auth.keySet ? "set" : "not set"}</p>}
    </li>;
  })}</ul>;
}

export function ProvidersSettings({ refreshKey, onChanged }: { refreshKey: number; onChanged?: () => Promise<void> | void }) {
  const { data, error: accountsError, load: loadAccounts } = useProviderUsage(refreshKey);
  const [config, setConfig] = useState<ProviderConfigs | null>(null);
  const [editing, setEditing] = useState<ProviderEdit | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const loadConfig = useCallback(async () => {
    const configured = await api<ProviderConfigs>("/providers/settings").catch(() => null);
    setConfig(configured && Array.isArray(configured.providers) ? configured : null);
  }, []);
  // Accounts come from the app's shared usage store, which also reloads them when an account changes.
  const load = useCallback(async () => { setError(""); await Promise.all([loadConfig(), loadAccounts()]); }, [loadConfig, loadAccounts]);
  function edit(provider: ProviderConfig) { setNotice(""); setError(""); setEditing({ id: provider.id, type: "custom", name: provider.name, baseUrl: provider.baseUrl ?? "", existing: true, credential: "preserve", secret: "" }); }
  async function saveProvider(event: React.FormEvent) {
    event.preventDefault(); if (!editing || !config?.write?.available || saving) return;
    setSaving(true); setError(""); setNotice("");
    try {
      const id = providerFormId({ type: editing.type, name: editing.name, ...(editing.existing ? { existingId: editing.id } : {}) }, config.providers.map(provider => provider.id));
      const saved = await api<ProviderConfigs>("/providers/settings", { version: config.version, id, name: editing.name.trim(), baseUrl: editing.baseUrl.trim(), credential: { action: editing.credential, ...(editing.credential === "replace" ? { value: editing.secret } : {}) } });
      setEditing(null); await load(); await onChanged?.(); setNotice(saved.application?.message ?? "Saved for new conversations and agents. Existing conversations keep their current provider settings.");
    } catch (e) { const fresh = await api<ProviderConfigs>("/providers/settings").catch(() => null); if (fresh && Array.isArray(fresh.providers)) setConfig(fresh); setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  }
  useEffect(() => { void loadConfig(); setWaiting(false); }, [loadConfig, refreshKey]);
  async function account(action: "chatgpt" | "signOut") {
    setBusy(true); setError("");
    try {
      const result = await api<{ authUrl?: string }>("/providers", { action });
      if (result.authUrl) { window.open(result.authUrl, "_blank", "noopener"); setWaiting(true); } else await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const custom = config && data ? config.providers.filter(provider => provider.id !== "openai" && provider.auth.source !== "subscription" && !provider.gateway && !data.openrouter.some(item => item.id === provider.id)) : [];
  const sub = (value: Subscription) => value.state === "connected" ? <State tone="ok">Connected</State> : value.state === "available" ? <State tone="warn">Models available</State> : <State tone="off">Not connected</State>;
  return <div className="grid gap-4" aria-label="Providers">
    <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Elpis models use the accounts connected on this computer.</p><Button variant="ghost" size="sm" onClick={() => void load()}><RefreshCw size={14} />Refresh</Button></div>
    <details className="provider-advanced"><summary>Advanced API connections</summary><p className="provider-note">Connect OpenRouter, a local server or another compatible service.</p><Button size="sm" variant="outline" disabled={!config?.write?.available || saving} onClick={() => { setNotice(""); setError(""); setEditing({ id: "", type: "custom", name: "", baseUrl: "", existing: false, credential: "preserve", secret: "" }); }}>Add API provider</Button></details>
    {(error || accountsError) && <p role="alert" className="text-sm text-destructive">{error || accountsError}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {config?.write?.reason && !config.write?.available && <p className="text-sm text-muted-foreground">{config.write?.reason}</p>}
    {editing && <form className="settings-card grid gap-4 p-5" aria-label="API provider settings" onSubmit={saveProvider}>
      <h3 className="font-semibold">{editing.existing ? `Edit ${editing.name}` : "Add API provider"}</h3>
      <p className="text-sm text-muted-foreground">Provider settings apply to new conversations and agents. Existing conversations keep their original connection settings and credentials.</p>
      {!editing.existing && <label className="field">Connection type<OptionSelect aria-label="Provider type" className="h-9 rounded-lg border bg-background px-3" value={editing.type} disabled={saving} onChange={event => { const type = event.target.value as ProviderType; setEditing({ ...editing, type, name: type === "openrouter" ? "OpenRouter" : type === "local" ? "Local server" : "", baseUrl: type === "openrouter" ? "https://openrouter.ai/api/v1" : type === "local" ? "http://127.0.0.1:1234/v1" : "", credential: "preserve", secret: "" }); }}><option value="openrouter">OpenRouter</option><option value="local">Local server</option><option value="custom">Other API service</option></OptionSelect></label>}
      <label className="field">Connection name<Input required aria-label="Provider display name" value={editing.name} disabled={saving} maxLength={200} placeholder="Name shown in Elpis" onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
      <label className="field">API endpoint<Input required aria-label="API endpoint" type="url" value={editing.baseUrl} disabled={saving} placeholder="https://api.example.com/v1" onChange={event => setEditing({ ...editing, baseUrl: event.target.value })} /></label>
      <p className="text-xs text-muted-foreground">Use a Responses API endpoint. Local servers can use HTTP; hosted services require HTTPS.</p>
      <label className="field">API key action<OptionSelect aria-label="API key action" className="h-9 rounded-lg border bg-background px-3" value={editing.credential} disabled={saving} onChange={event => setEditing({ ...editing, credential: event.target.value as ProviderEdit["credential"], secret: "" })}><option value="preserve">{editing.existing ? "Keep current key" : "No key"}</option><option value="replace">Set a new key</option><option value="clear">Clear stored key</option></OptionSelect></label>
      {editing.credential === "clear" && <p className="text-sm text-muted-foreground">{config?.application?.credentialClearMessage ?? "This clears the saved key for new conversations. Existing conversations keep their original credentials."}</p>}
      {editing.credential === "replace" && <label className="field">API key<Input aria-label="Provider API key" type="password" autoComplete="new-password" value={editing.secret} disabled={saving} onChange={event => setEditing({ ...editing, secret: event.target.value })} placeholder="Enter API key" /><span className="text-xs text-muted-foreground">Saved keys are never displayed. An empty field keeps the current key.</span></label>}
      {editing.existing && <p className="text-xs text-muted-foreground">Current key: {config?.providers.find(provider => provider.id === editing.id)?.auth.keySet ? "set" : "not set"}</p>}
      <div className="flex gap-2"><Button type="submit" disabled={!config?.write?.available || saving || !editing.name.trim() || !editing.baseUrl.trim()}>{saving ? "Saving…" : "Save provider"}</Button><Button type="button" variant="outline" disabled={saving} onClick={() => setEditing(null)}>Cancel</Button></div>
    </form>}
    {!data && !accountsError && <p role="status" className="text-sm text-muted-foreground">Reading providers…</p>}
    {data && <>
      <Card id="openai" name="OpenAI / ChatGPT" state={data.openai.auth.state === "signedIn" ? <State tone="ok">Signed in{data.openai.auth.method ? ` with ${data.openai.auth.method}` : ""}</State> : data.openai.auth.state === "unknown" ? <State tone="warn">Sign-in state unavailable</State> : <State tone="off">Not signed in</State>}>
        {data.openai.auth.email && <p className="text-sm">{data.openai.auth.email}{data.openai.auth.plan ? ` · ${data.openai.auth.plan} plan` : ""}</p>}
        <div className="flex flex-wrap gap-2">
          {data.openai.auth.state === "signedIn"
            ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void account("signOut")}>Sign out</Button>
            : <Button size="sm" disabled={busy} onClick={() => void account("chatgpt")}>Sign in with ChatGPT</Button>}
          {waiting && <span role="status" className="self-center text-sm text-muted-foreground">Complete sign-in in the page that opened.</span>}
        </div>
      </Card>
      <Card id="claude" name="Anthropic" state={sub(data.claude)}>
        <p className="provider-note">{data.claude.models.length ? `${plural(data.claude.models.length, "Claude model")} available through your Claude Code connection.` : "Sign in to Claude Code on this computer to connect your subscription."}</p>
      </Card>
      <Card id="gemini" name="Antigravity" state={sub(data.gemini)}>
        <p className="provider-note">{data.gemini.models.length ? `${plural(data.gemini.models.length, "model")} available through your existing Google/Antigravity connection.` : "Sign in to Antigravity with Google on this computer to connect its models."}</p>
      </Card>
      {data.openrouter.length > 0 && <Card id="openrouter" name="OpenRouter" state={data.openrouter.length ? (data.openrouter.every(item => item.keySet) ? <State tone="ok">Key set</State> : <State tone="warn">Key missing</State>) : <State tone="off">Not configured</State>}>
        <ConfiguredList config={config} onEdit={edit} items={data.openrouter} empty="No OpenRouter connection yet." />
      </Card>}
      {custom.length > 0 && <Card id="custom" name="Custom API providers" state={<State tone="ok">Configured</State>}><ConfiguredList config={config} onEdit={edit} empty="No custom providers configured." items={custom.map(provider => ({ id: provider.id, name: provider.name, baseUrl: provider.baseUrl, envKey: provider.auth.envKey, keySet: provider.auth.keySet }))} /></Card>}
    </>}
  </div>;
}
