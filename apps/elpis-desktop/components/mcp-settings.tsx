"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { SettingsEmpty, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api, type Model } from "@/lib/api";
import { ModelChoice } from "@/components/settings/maintenance";

type Credential = { name: string; source: "config" | "environment"; set: boolean };
type Server = { name: string; enabled: boolean; transport: "stdio" | "http"; command: string | null; url: string | null; credentials: Credential[]; whispertype?: { backend: "openrouter" | "codex" | "local"; model: string | null } };
type Mcp = { configPath?: string | null; reloadRequested?: boolean; version: string | null; write: { available: boolean }; servers: Server[] };
type Stage = { stage: "embedding" | "reranking" | "generation"; provider: string | null; model: string | null; location: "local" | "api" | null };
type Rag = { stages: Stage[]; keys: { openrouter: boolean } };

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
/** A reply without its server list (an older or failing bridge) reads as no servers, never as a broken page. */
const readMcp = (value: Mcp): Mcp => ({ ...value, servers: Array.isArray(value?.servers) ? value.servers : [], write: value?.write ?? { available: false } });
/** What the rag tool accepts for its reranker (bridge/tools.mjs): off, the local engine, or an OpenRouter reranker ID. */
const RERANKERS: Model[] = [["off", "Off"], ["fastembed", "Local (FastEmbed)"], ["cohere/rerank-4-fast", "Cohere Rerank 4 Fast (OpenRouter)"]].map(([model, displayName]) => ({ id: model, model, displayName }));
const providerName = (stage: Stage) => stage.location === "local" ? "Local" : stage.provider === "openrouter" ? "OpenRouter" : stage.provider === "openai_compatible" ? "OpenAI-compatible API" : stage.provider ?? "Not set";
const Key = ({ name, set, note, plain }: { name: string; set: boolean; note?: string; plain?: boolean }) => <li className={`key-state ${set ? "set" : "unset"}`}>{plain ? name : <code>{name}</code>} · {set ? "set" : "not set"}{note && <span className="text-muted-foreground"> ({note})</span>}</li>;

function CredentialSettings({ server, disabled, save }: { server: Server; disabled: boolean; save: (body: Record<string, unknown>) => Promise<void> }) {
  const names = Array.from(new Set([...server.credentials.filter(key => /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIALS?)(?:_|$)/i.test(key.name)).map(key => key.name), ...(server.name === "rag" ? ["OPENROUTER_API_KEY"] : server.name === "whispertype" ? ["OPENROUTER_API_KEY_COMPANY"] : [])]));
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!names.length) return null;
  // Elpis gives an HTTP server only the token named by bearer_token_env_var, read from its environment; it refuses `env` there.
  if (server.transport === "http") return <p className="text-xs text-muted-foreground">This server reads its key from {names.map(name => <code key={name}>{name}</code>)} in the environment Elpis starts with; set it there and restart Elpis.</p>;
  return <form className="mcp-tool-settings settings-form" aria-label={`API keys for ${server.name}`} onSubmit={async event => {
    event.preventDefault(); setBusy(true); setSaved(false);
    try { await save({ action: "credentials", env: Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())) }); setValues({}); setSaved(true); }
    catch {} finally { setBusy(false); }
  }}>
    <div><p className="text-sm font-medium">API keys</p><p className="text-xs text-muted-foreground">Leave a field empty to keep its current key. Saved keys are never displayed.</p></div>
    <div className="grid gap-3 sm:grid-cols-2">{names.map(name => <label className="field min-w-0" key={name}><span className="break-all text-xs">{name}</span><Input type="password" autoComplete="new-password" aria-label={`${server.name} ${name}`} value={values[name] ?? ""} placeholder={server.credentials.find(key => key.name === name)?.set ? "Key is set · enter to replace" : "Enter API key"} disabled={disabled || busy} onChange={event => { setSaved(false); setValues(previous => ({ ...previous, [name]: event.target.value })); }} /></label>)}</div>
    <Button type="submit" variant="outline" className="justify-self-start" disabled={disabled || busy || !Object.values(values).some(value => value.trim())}>{busy ? "Saving…" : "Save API keys"}</Button>
    {saved && <p role="status" className="text-xs text-muted-foreground">API keys saved.</p>}
  </form>;
}

function RagSettings({ version }: { version: string | null }) {
  const [rag, setRag] = useState<Rag | null>(null);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [reranker, setReranker] = useState("");
  const [busy, setBusy] = useState(false);
  const [answerModels, setAnswerModels] = useState<Model[]>([]);
  useEffect(() => { api<Rag>("/tools/rag").then(setRag).catch(e => setError(message(e))); }, [version]);
  useEffect(() => { api<{ data: Model[] }>("/models?provider=openrouter").then(result => setAnswerModels(Array.isArray(result?.data) ? result.data : [])).catch(() => setAnswerModels([])); }, []);
  async function save(stage: "generation" | "reranking", model: string) {
    setBusy(true); setError("");
    try { setRag(await api<Rag>("/tools/rag", { stage, model })); if (stage === "generation") setAnswer(""); else setReranker(""); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  if (error && !rag) return <SettingsNotice tone="alert">Could not read RAG settings: {error}</SettingsNotice>;
  if (!rag) return <SettingsNotice>Reading RAG settings…</SettingsNotice>;
  const stage = (id: Stage["stage"]) => rag.stages.find(item => item.stage === id);
  const label = { embedding: "Embedding", reranking: "Reranker", generation: "Answer model" } as const;
  return <div className="grid gap-3">
    <dl className="mcp-values">{(["embedding", "reranking", "generation"] as const).map(id => { const value = stage(id); return <div key={id}><dt>{label[id]}</dt><dd>{value ? `${providerName(value)} · ${value.model ?? "no model"}` : "Not configured"}</dd></div>; })}</dl>
    <ul className="grid gap-1 text-sm"><Key name="OpenRouter key" plain set={rag.keys.openrouter} note="as rag sees it" /></ul>
    <div className="grid gap-3 sm:grid-cols-2">
      <form className="field" onSubmit={e => { e.preventDefault(); void save("generation", answer.trim()); }}>Change answer model (OpenRouter)
        <div className="flex gap-2"><ModelChoice label="RAG answer model" value={answer || stage("generation")?.model || null} models={answerModels} provider="OpenRouter" disabled={busy} onChange={model => setAnswer(model ?? "")} /><Button type="submit" variant="outline" disabled={busy || !answer.trim() || answer === stage("generation")?.model}>Save</Button></div></form>
      <form className="field" onSubmit={e => { e.preventDefault(); void save("reranking", reranker.trim()); }}>Change reranker
        <div className="flex gap-2"><ModelChoice label="RAG reranker" value={reranker || stage("reranking")?.model || null} models={RERANKERS} provider="OpenRouter" disabled={busy} onChange={model => setReranker(model ?? "")} /><Button type="submit" variant="outline" disabled={busy || !reranker.trim() || reranker === stage("reranking")?.model}>Save</Button></div></form>
    </div>
    <p className="provider-note">Embeddings change with <code>rag setup</code> because documents are re-indexed. Agents search documents with the <code>rag</code> tool.</p>
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
  </div>;
}

export function McpSettings({ onOpenVoice }: { onOpenVoice?: () => void }) {
  const [notice, setNotice] = useState("");
  const [data, setData] = useState<Mcp | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", command: "", args: "" });
  const [removing, setRemoving] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(readMcp(await api<Mcp>("/mcp"))); } catch (e) { setError(message(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function save(name: string, body: Record<string, unknown>) {
    setError("");
    try { setNotice(""); const saved = readMcp(await api<Mcp>("/mcp", { version: data?.version, name, ...body })); setData(saved); if (saved.reloadRequested === false) setNotice("Settings saved. Elpis could not refresh the active tools; reconnect Elpis to apply them."); }
    catch (e) { setError(message(e)); await load(); throw e; }
  }
  async function add(event: React.FormEvent) {
    event.preventDefault();
    try { await save(draft.name.trim(), { action: "add", command: draft.command.trim(), args: draft.args.split("\n").map(arg => arg.trim()).filter(Boolean) }); setAdding(false); setDraft({ name: "", command: "", args: "" }); } catch {}
  }
  return <div aria-label="MCP servers">
    <SettingsHeader title="MCP servers" description="Server choices apply to new chats; stored API keys stay on this device." action={<Button variant="outline" onClick={() => setAdding(true)} disabled={!data?.write?.available}><Plus />Add MCP server</Button>} />
    <div className="settings-stack">
    {error && <SettingsNotice tone="alert">{error}</SettingsNotice>}
    {notice && <SettingsNotice>{notice}</SettingsNotice>}
    {data?.configPath && <details className="text-xs text-muted-foreground"><DisclosureSummary className="cursor-pointer">Configuration file</DisclosureSummary><p className="mt-2 break-all">{data.configPath}</p></details>}
    {adding && <form className="settings-card settings-form" aria-label="Add MCP server" onSubmit={add}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="field">Server name<Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="letters, numbers, - or _" /></label>
        <label className="field">Command<Input value={draft.command} onChange={e => setDraft({ ...draft, command: e.target.value })} placeholder="/path/to/server or an executable name" /></label>
      </div>
      <label className="field">Arguments<Textarea value={draft.args} onChange={e => setDraft({ ...draft, args: e.target.value })} placeholder="One argument per line" rows={2} /></label>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" disabled={!draft.name.trim() || !draft.command.trim()}>Save server</Button></div>
    </form>}
    {!data && !error && <SettingsNotice>Reading MCP servers…</SettingsNotice>}
    {data && !data.servers.length && <SettingsEmpty title="No MCP servers are configured">Add one to give your agents its tools.</SettingsEmpty>}
    {data?.servers.map(server => <section key={server.name} className="mcp-server settings-card" data-name={server.name} aria-label={server.name}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-mono">{server.name}</h3><span className="settings-scope">new chats</span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={server.command ?? server.url ?? ""}>{server.transport === "http" ? server.url : server.command}</span>
        <Switch aria-label={`Enable ${server.name}`} checked={server.enabled} disabled={!data.write?.available} onCheckedChange={enabled => void save(server.name, { action: "enable", enabled }).catch(() => {})} />
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${server.name}`} disabled={!data.write?.available} onClick={() => setRemoving(server.name)}><Trash2 size={14} /></Button>
      </header>
      {server.credentials.length > 0 && <ul className="grid gap-1 text-sm">{server.credentials.map(item => <Key key={`${item.source}:${item.name}`} name={item.name} set={item.set} note={item.source === "environment" ? "from the environment" : "in config"} />)}</ul>}
      <CredentialSettings server={server} disabled={!data.write?.available} save={body => save(server.name, body)} />
      {server.name === "rag" && <RagSettings version={data.version} />}
      {server.name === "whispertype" && <p className="provider-note">The microphone’s transcription route is set under Voice.{onOpenVoice && <> <Button variant="link" size="xs" className="h-auto p-0 align-baseline" onClick={onOpenVoice}>Open Voice settings</Button></>}</p>}
    </section>)}
    </div>
    <AlertDialog open={!!removing} onOpenChange={open => { if (!open) setRemoving(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove “{removing}”?</AlertDialogTitle>
          <AlertDialogDescription>Elpis agents lose this server's tools. Its entry is deleted from your Elpis config.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={() => { const name = removing; setRemoving(null); if (name) void save(name, { action: "remove" }).catch(() => {}); }}>Remove</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
