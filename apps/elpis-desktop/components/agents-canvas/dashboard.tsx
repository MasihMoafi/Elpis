import { useEffect, useRef, useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { summarize, workedFor } from "@/components/transcript";
import { api, type Entry } from "@/lib/api";
import { CHECK_LABEL, DONE, STATUS_LABEL, type CanvasNode, type TaskStatus } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import { folderLabel } from "./folders";

/** One agent's info panel (Enter or double-click): what it is, what it waits for and feeds, and, once it runs, what it
 * has done so far from its own chat, refreshed while it works. */
/** What a chat has done so far, read from it, and again every 2 s while it works: an agent's, or the Mother agent's. */
export function LiveFeed({ chat, working, idle, ready }: { chat: string | null; working: boolean; idle: string; ready: boolean }) {
  const [entries, setEntries] = useState<Entry[] | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!ready || !chat) return;
    let live = true;
    const read = () => api<{ data: Entry[] }>(`/threads/${encodeURIComponent(chat)}?limit=100`).then(result => { if (live) { setEntries(result.data); setError(""); } }).catch(cause => { if (live) setError(errorText(cause)); });
    void read();
    const timer = working ? setInterval(() => void read(), 2000) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [chat, working, ready]);
  const items = entries?.map(entry => entry.item) ?? [];
  const said = [...items].reverse().find(item => item.type === "agentMessage" && typeof item.text === "string")?.text;
  return <section className="agent-dashboard-live" aria-label="Live">
    <p className="hud-menu-title">Live</p>
    {!chat ? <p>{idle}</p>
      : !ready && !entries ? <p>Reconnect to read its chat.</p>
      : ready && error ? <p role="alert">{error}</p>
      : !entries ? <p>Reading its chat…</p>
      : <><p>{workedFor(entries)} · {summarize(items) || "nothing yet"}</p>{said && <blockquote>{said}</blockquote>}</>}
  </section>;
}

export type AgentOutput = { did: string | null; report: string | null; outputs: { path: string; size: number; lines: string[] | null }[]; check: { report: string | null; verdicts: { state: "passed" | "failed" | "unclear"; criterion: string; detail: string }[] } | null };

/** A saved run's own evidence, inside the selected-agent drawer. The bridge reads only reported files in the agent's
 * allowed folders; the drawer refreshes while the task is still writing its report. */
export function AgentRunOutput({ runId, taskId, working, ready }: { runId: string; taskId: string; working: boolean; ready: boolean }) {
  const [output, setOutput] = useState<AgentOutput | null>(null), [error, setError] = useState("");
  useEffect(() => {
    if (!ready) return;
    let live = true;
    const read = () => api<AgentOutput>(`/workflows/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(taskId)}/output`)
      .then(result => { if (live) { setOutput(result); setError(""); } })
      .catch(cause => { if (live) setError(errorText(cause)); });
    void read();
    const timer = working ? setInterval(() => void read(), 2000) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [runId, taskId, working, ready]);
  return <div className="agent-run-output" aria-label="Agent output">
    <section><h3>What it did</h3><p>{!ready && !output ? "Reconnect to read its report." : error ? <span role="alert">{error}</span> : !output ? "Reading its report…" : output.did || (working ? "It is still working. Its result will appear here." : "No result was recorded in its report.")}</p></section>
    {output && <section><h3>Output</h3>{output.outputs.length ? <div className="agent-output-files">{output.outputs.map(file => <article key={file.path}>
      <strong title={file.path}>{file.path}</strong>{file.lines ? <pre><code>{file.lines.join("\n")}</code></pre> : <p>Binary file · {file.size.toLocaleString()} bytes</p>}
    </article>)}</div> : <p>{working ? "Output previews will appear after its report names the files." : "Its report named no output files to preview."}</p>}</section>}
    {output?.check && <section><h3>Checker</h3>{output.check.verdicts.length ? <ul className="agent-verdicts">{output.check.verdicts.map((verdict, index) => <li key={`${verdict.criterion}-${index}`} data-state={verdict.state}>
      <strong>{verdict.state === "passed" ? "Passed" : verdict.state === "failed" ? "Failed" : "Unclear"}</strong><span>{verdict.criterion}</span>{verdict.detail && <small>{verdict.detail}</small>}
    </li>)}</ul> : <p>{working ? "The checker has not reported yet." : "The checker recorded no verdicts."}</p>}</section>}
  </div>;
}

export function AgentDashboard({ node, own, status, check, clash, chat, waitsFor, feeds, modelLabel, ready, onOpenChat, onSettings, onClose }: { node: Extract<CanvasNode, { type: "agent" }>; own: string; status: TaskStatus | "idle"; check: TaskStatus | "idle"; clash?: string[] | undefined; chat: string | null; waitsFor: string[]; feeds: string[]; modelLabel: string; ready: boolean; onOpenChat: (id: string) => void; onSettings: () => void; onClose: () => void }) {
  const data = node.data, panel = useRef<HTMLDivElement>(null);
  // A click anywhere else on the page closes it, as Escape does.
  useEffect(() => {
    const away = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !panel.current?.contains(target) && !target.closest("[data-agent-info]")) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onClose]);
  return <div ref={panel} className="agent-dashboard hud-menu" role="dialog" tabIndex={-1} aria-label={`${data.title} info`} data-kind="agent" data-status={status}
    onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><span className="agent-node-kind">Agent · {STATUS_LABEL[status]}</span><strong>{data.title || "Untitled"}</strong>
      <Button variant="ghost" size="icon-xs" aria-label="Close info" autoFocus onClick={onClose}><X size={14} /></Button></header>
    <dl>
      <div><dt>Model</dt><dd>{modelLabel}{data.effort ? ` · ${data.effort} thinking` : ""}</dd></div>
      <div><dt>Inputs needed</dt><dd>{waitsFor.length ? waitsFor.join(", ") : "All inputs captured"}</dd></div>
      <div><dt>Feeds</dt><dd>{feeds.length ? feeds.join(", ") : "The Mother agent's report"}</dd></div>
      <div><dt>May write</dt><dd>{[own, ...data.writeScopes.map(folderLabel)].join(", ")}</dd></div>
      <div><dt>Prompt</dt><dd>{data.instruction || "No prompt yet: write one before the run"}</dd></div>
      <div><dt>Done when</dt><dd>{(data.acceptanceCriteria.length ? data.acceptanceCriteria : [DONE]).join("; ")}</dd></div>
      <div><dt>Its check</dt><dd>{CHECK_LABEL[check]}</dd></div>
      {clash && <div><dt>Merge clash</dt><dd>{clash.join("\n")}</dd></div>}
    </dl>
    <Button variant="outline" size="sm" onClick={onSettings}>Settings</Button>
    <LiveFeed chat={chat} working={status === "running"} ready={ready} idle="Not started. What it does shows here once the graph runs." />
    {chat && <Button variant="outline" size="sm" onClick={() => onOpenChat(chat)}><ExternalLink size={14} />Open its chat</Button>}
  </div>;
}