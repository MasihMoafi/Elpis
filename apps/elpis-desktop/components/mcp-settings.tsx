"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";

type Credential = { name: string; source: "config" | "environment"; set: boolean };
type Server = { name: string; enabled: boolean; transport: "stdio" | "http"; command: string | null; url: string | null; credentials: Credential[]; whispertype?: { backend: "openrouter" | "codex" | "local"; model: string | null } };
type Mcp = { configPath?: string | null; reloadRequested?: boolean; version: string | null; write: { available: boolean }; servers: Server[] };
type Stage = { stage: "embedding" | "reranking" | "generation"; provider: string | null; model: string | null; location: "local" | "api" | null };
type Rag = { stages: Stage[]; keys: { openrouter: boolean } };

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const providerName = (stage: Stage) => stage.location === "local" ? "Local" : stage.provider === "openrouter" ? "OpenRouter" : stage.provider === "openai_compatible" ? "OpenAI-compatible API" : stage.provider ?? "Not set";
const Key = ({ name, set, note, plain }: { name: string; set: boolean; note?: string; plain?: boolean }) => <li className={`key-state ${set ? "set" : "unset"}`}>{plain ? name : <code>{name}</code>} · {set ? "set" : "not set"}{note && <span className="text-muted-foreground"> ({note})</span>}</li>;

function CredentialSettings({ server, disabled, save }: { server: Server; disabled: boolean; save: (body: Record<string, unknown>) => Promise<void> }) {
  const names = Array.from(new Set([...server.credentials.filter(key => /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|AUTHORIZATION|CREDENTIALS?)(?:_|$)/i.test(key.name)).map(key => key.name), ...(server.name === "rag" ? ["OPENROUTER_API_KEY"] : server.name === "whispertype" ? ["OPENROUTER_API_KEY_COMPANY"] : [])]));
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  if (!names.length) return null;
  return <form className="mcp-tool-settings" aria-label={`API keys for ${server.name}`} onSubmit={async event => {
    event.preventDefault(); setBusy(true); setSaved(false);
    try { await save({ action: "credentials", env: Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim())) }); setValues({}); setSaved(true); }
    catch {} finally { setBusy(false); }
  }}>
    <p className="text-sm font-medium">API keys</p><p className="text-xs text-muted-foreground">Leave a field empty to keep its current key. Saved keys are never displayed.</p>
    <div className="grid gap-3 sm:grid-cols-2">{names.map(name => <label className="field min-w-0" key={name}><span className="break-all text-xs">{name}</span><Input type="password" autoComplete="new-password" aria-label={`${server.name} ${name}`} value={values[name] ?? ""} placeholder={server.credentials.find(key => key.name === name)?.set ? "Key is set · enter to replace" : "Enter API key"} disabled={disabled || busy} onChange={event => { setSaved(false); setValues(previous => ({ ...previous, [name]: event.target.value })); }} /></label>)}</div>
    <Button type="submit" variant="outline" size="sm" disabled={disabled || busy || !Object.values(values).some(value => value.trim())}>{busy ? "Saving…" : "Save API keys"}</Button>
    {saved && <p role="status" className="text-xs text-muted-foreground">API keys saved.</p>}
  </form>;
}

function RagSettings({ version }: { version: string | null }) {
  const [rag, setRag] = useState<Rag | null>(null);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [reranker, setReranker] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<Rag>("/tools/rag").then(setRag).catch(e => setError(message(e))); }, [version]);
  async function save(stage: "generation" | "reranking", model: string) {
    setBusy(true); setError("");
    try { setRag(await api<Rag>("/tools/rag", { stage, model })); if (stage === "generation") setAnswer(""); else setReranker(""); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  if (error && !rag) return <p role="alert" className="text-sm text-destructive">Could not read RAG settings: {error}</p>;
  if (!rag) return <p role="status" className="text-sm text-muted-foreground">Reading RAG settings…</p>;
  const stage = (id: Stage["stage"]) => rag.stages.find(item => item.stage === id);
  const label = { embedding: "Embedding", reranking: "Reranker", generation: "Answer model" } as const;
  return <div className="grid gap-3">
    <dl className="mcp-values">{(["embedding", "reranking", "generation"] as const).map(id => { const value = stage(id); return <div key={id}><dt>{label[id]}</dt><dd>{value ? `${providerName(value)} · ${value.model ?? "no model"}` : "Not configured"}</dd></div>; })}</dl>
    <ul className="grid gap-1 text-sm"><Key name="OpenRouter key" plain set={rag.keys.openrouter} note="as rag sees it" /></ul>
    <div className="grid gap-3 sm:grid-cols-2">
      <form className="field" onSubmit={e => { e.preventDefault(); void save("generation", answer.trim()); }}>Change answer model (OpenRouter)
        <div className="flex gap-2"><Input aria-label="RAG answer model" placeholder="e.g. deepseek/deepseek-v4.1-flash" value={answer} onChange={e => setAnswer(e.target.value)} /><Button type="submit" variant="outline" disabled={busy || !answer.trim()}>Save</Button></div></form>
      <form className="field" onSubmit={e => { e.preventDefault(); void save("reranking", reranker.trim()); }}>Change reranker
        <div className="flex gap-2"><Input aria-label="RAG reranker" placeholder="off, fastembed (local) or cohere/rerank-4-fast" value={reranker} onChange={e => setReranker(e.target.value)} /><Button type="submit" variant="outline" disabled={busy || !reranker.trim()}>Save</Button></div></form>
    </div>
    <p className="provider-note">Embeddings change with <code>rag setup</code> because documents are re-indexed. Agents search documents with the <code>rag</code> tool.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}

export function WhisperTypeSettings({ server, save, disabled = false }: { server: Pick<Server, "whispertype">; save: (body: Record<string, unknown>) => Promise<void>; disabled?: boolean }) {
  const [backend, setBackend] = useState(server.whispertype?.backend ?? "openrouter");
  const [model, setModel] = useState(server.whispertype?.model ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); event.stopPropagation(); if (busy || disabled) return; setBusy(true); setError("");
    try { await save({ action: "whispertype", backend, ...(backend === "openrouter" ? { model: model.trim() || null } : {}) }); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <form className="grid gap-3" onSubmit={submit}>
    <label className="field">Transcription engine<OptionSelect aria-label="Transcription engine" className="w-full" value={backend} disabled={disabled || busy} onChange={e => setBackend(e.target.value as "openrouter" | "codex" | "local")}><option value="local">Local WhisperType</option><option value="openrouter">OpenRouter</option><option value="codex">ChatGPT sign-in</option></OptionSelect></label>
    {backend === "openrouter" && <label className="field">Transcription model<Input aria-label="Transcription model" value={model} onChange={e => setModel(e.target.value)} placeholder="openai/gpt-4o-mini-transcribe" disabled={disabled || busy} /></label>}
    <p className="text-xs text-muted-foreground">{backend === "local" ? "Audio stays on this computer. Uses your installed WhisperType model." : backend === "codex" ? "Uses WhisperType's existing ChatGPT sign-in for cloud transcription." : "Audio uses your configured OpenRouter transcription model and credentials."}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" variant="outline" aria-label="Save transcription settings" disabled={disabled || busy}>{busy ? "Saving…" : "Save"}</Button>
  </form>;
}

export function McpSettings() {
  const [notice, setNotice] = useState("");
  const [data, setData] = useState<Mcp | null>(null);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", command: "", args: "" });
  const [removing, setRemoving] = useState<string | null>(null);
  const load = useCallback(async () => { try { setData(await api<Mcp>("/mcp")); } catch (e) { setError(message(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function save(name: string, body: Record<string, unknown>) {
    setError("");
    try { setNotice(""); const saved = await api<Mcp>("/mcp", { version: data?.version, name, ...body }); setData(saved); if (saved.reloadRequested === false) setNotice("Settings saved. Elpis could not refresh the active tools; reconnect Elpis to apply them."); }
    catch (e) { setError(message(e)); await load(); throw e; }
  }
  async function add(event: React.FormEvent) {
    event.preventDefault();
    try { await save(draft.name.trim(), { action: "add", command: draft.command.trim(), args: draft.args.split("\n").map(arg => arg.trim()).filter(Boolean) }); setAdding(false); setDraft({ name: "", command: "", args: "" }); } catch {}
  }
  return <div className="grid gap-4" aria-label="MCP servers">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">Manage the tools available to your agents and their API keys.</p>
      <Button size="sm" onClick={() => setAdding(true)} disabled={!data?.write.available}><Plus size={14} />Add MCP server</Button>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {data?.configPath && <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Configuration file</summary><p className="mt-2 break-all">{data.configPath}</p></details>}
    {adding && <form className="settings-card grid gap-3 p-4" aria-label="Add MCP server" onSubmit={add}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="field">Server name<Input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} placeholder="letters, numbers, - or _" /></label>
        <label className="field">Command<Input value={draft.command} onChange={e => setDraft({ ...draft, command: e.target.value })} placeholder="/path/to/server or an executable name" /></label>
      </div>
      <label className="field">Arguments<Textarea value={draft.args} onChange={e => setDraft({ ...draft, args: e.target.value })} placeholder="One argument per line" rows={2} /></label>
      <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={() => setAdding(false)}>Cancel</Button><Button type="submit" disabled={!draft.name.trim() || !draft.command.trim()}>Save server</Button></div>
    </form>}
    {!data && !error && <p role="status" className="text-sm text-muted-foreground">Reading MCP servers…</p>}
    {data && !data.servers.length && <p className="provider-note">No MCP servers are configured.</p>}
    {data?.servers.map(server => <section key={server.name} className="mcp-server settings-card" data-name={server.name} aria-label={server.name}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="font-mono">{server.name}</h3>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={server.command ?? server.url ?? ""}>{server.transport === "http" ? server.url : server.command}</span>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" aria-label={`Enable ${server.name}`} checked={server.enabled} disabled={!data.write.available} onChange={e => void save(server.name, { action: "enable", enabled: e.target.checked }).catch(() => {})} />Enabled</label>
        <Button variant="ghost" size="icon-sm" aria-label={`Remove ${server.name}`} disabled={!data.write.available} onClick={() => setRemoving(server.name)}><Trash2 size={14} /></Button>
      </header>
      {server.credentials.length > 0 && <ul className="grid gap-1 text-sm">{server.credentials.map(item => <Key key={`${item.source}:${item.name}`} name={item.name} set={item.set} note={item.source === "environment" ? "from the environment" : "in config"} />)}</ul>}
      <CredentialSettings server={server} disabled={!data.write.available} save={body => save(server.name, body)} />
      {server.name === "rag" && <RagSettings version={data.version} />}
      {server.name === "whispertype" && <WhisperTypeSettings server={server} disabled={!data.write.available} save={body => save(server.name, body)} />}
    </section>)}
    <AlertDialog open={!!removing} onOpenChange={open => { if (!open) setRemoving(null); }}>
      <AlertDialogContent>
        <AlertDialogTitle>Remove “{removing}”?</AlertDialogTitle>
        <AlertDialogDescription>Elpis agents lose this server's tools. Its entry is deleted from your Elpis config.</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={() => { const name = removing; setRemoving(null); if (name) void save(name, { action: "remove" }).catch(() => {}); }}>Remove</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
