"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { Browser } from "@/components/browser-panel";

type Candidate = { name: string; command: string };
type Server = Candidate & { status: "starting" | "running" | "stopped" | "failed"; url: string; logs: string; error: string | null };
type Status = { servers: Server[] };

/** Project commands are offered before anything runs; the bridge owns their processes and bounded log buffers. */
export function DevServerPreview({ cwd, browser }: { cwd: string; browser: Browser }) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null), [servers, setServers] = useState<Server[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [logs, setLogs] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    setCandidates(null); setServers([]); setError(""); setLogs(null);
    const poll = async () => {
      try { const reply = await api<Status>(`/dev-servers?cwd=${encodeURIComponent(cwd)}`); if (!disposed) setServers(reply.servers ?? []); }
      catch (e) { if (!disposed) setError(e instanceof Error ? e.message : String(e)); }
      if (!disposed) timer = setTimeout(poll, 1000);
    };
    if (cwd) void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [cwd]);
  async function detect() {
    setBusy(true); setError("");
    try { setCandidates((await api<{ candidates: Candidate[] }>("/dev-servers/detect", { cwd })).candidates); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function act(action: "start" | "stop", name: string) {
    setBusy(true); setError("");
    try {
      const reply = await api<Status>(`/dev-servers/${action}`, { cwd, name }); setServers(reply.servers);
      const ready = reply.servers.find(server => server.name === name && server.status === "running");
      if (action === "start" && ready) await browser.command("navigate", { id: browser.state?.activeId ?? undefined, url: ready.url });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  if (!cwd) return null;
  const offered = candidates?.filter(candidate => !servers.some(server => server.name === candidate.name && ["running", "starting"].includes(server.status))) ?? [];
  return <section aria-label="Dev server preview" className="max-h-[60%] shrink-0 space-y-2 overflow-y-auto border-b border-border bg-background p-3 text-sm text-foreground">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="font-medium">Preview</span>
      <Button type="button" size="sm" variant="ghost" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void detect()}>{busy ? "Working…" : "Detect dev server"}</Button>
    </div>
    {error && <p role="alert" className="alert alert-vertical break-words text-destructive">{error}</p>}
    {offered.length > 0 && <>
      <p className="text-muted-foreground">Dev server detected. This command runs in your shell when the preview starts.</p>
      {offered.map(candidate => <div key={candidate.name} className="flex flex-wrap items-center justify-between gap-2">
        <code className="min-w-0 break-all">{candidate.command}</code>
        <Button type="button" size="sm" variant="outline" className="btn btn-sm shrink-0" aria-label={`Start preview: ${candidate.name}`} disabled={busy} onClick={() => void act("start", candidate.name)}>Start preview</Button>
      </div>)}
      <p className="text-xs text-muted-foreground">Your choice is saved to .elpis/launch.json in this project.</p>
    </>}
    {candidates?.length === 0 && <p role="status" className="text-muted-foreground">No dev server found in this project.</p>}
    {servers.map(server => <div key={server.name} className="space-y-2">
      <p role="status" className="break-words">{new URL(server.url).hostname} · {server.status === "running" ? "Server running" : server.status === "starting" ? "Server starting…" : server.status === "stopped" ? "Server stopped" : "Dev server failed to start"}</p>
      <div className="flex flex-wrap items-center gap-2">
        {server.status === "running" || server.status === "starting" ? <Button type="button" size="sm" variant="outline" className="btn btn-sm" disabled={busy} onClick={() => void act("stop", server.name)}>Stop server</Button>
          : <Button type="button" size="sm" variant="outline" className="btn btn-sm" disabled={busy} onClick={() => void act("start", server.name)}>Restart server</Button>}
        {server.status === "running" && <Button type="button" size="sm" variant="ghost" className="btn btn-sm btn-ghost" onClick={() => void browser.command("navigate", { url: server.url })}>Open preview</Button>}
        <Button type="button" size="sm" variant="ghost" className="btn btn-sm btn-ghost" aria-expanded={logs === server.name} onClick={() => setLogs(logs === server.name ? null : server.name)}>{logs === server.name ? "Hide logs" : "View logs"}</Button>
      </div>
      {server.error && <p className="text-destructive">{server.error}</p>}
      {logs === server.name && <pre role="log" aria-label="Dev server logs" tabIndex={0} className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 text-xs text-foreground">{server.logs || "Waiting for server output…"}</pre>}
    </div>)}
  </section>;
}
