"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { openRef } from "@/lib/files-pane";

// thread/contextFiles/list and /set return the refreshed sources, including rows sharing one admission setting.
type ContextFile = {
  name: string; path: string; group: "sessionContinuity" | "durableMemory" | "instructions";
  estimatedTokens: number; included: boolean; reason: string; selectable: boolean;
};
type Sources = { files: ContextFile[] };
const groups = [
  ["sessionContinuity", "SESSION CONTINUITY"], ["durableMemory", "DURABLE MEMORY"], ["instructions", "INSTRUCTIONS"],
] as const;
const tokens = (count: number) => count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(count);
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
/** An opening must reach either readable content or Retry even if its local bridge stops replying. */
export async function readContext<T>(endpoint: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(), cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([api<T>(endpoint, undefined, controller.signal), new Promise<T>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("Reading context took too long. Try again.")); }, 10000);
    })]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
function sourcesOf(value: unknown): Sources {
  const result = value as Partial<Sources> | null;
  if (!Array.isArray(result?.files) || !result.files.every(file => file && typeof file.name === "string" && typeof file.path === "string"
    && groups.some(([group]) => group === file.group) && Number.isFinite(file.estimatedTokens) && file.estimatedTokens >= 0
    && typeof file.included === "boolean" && typeof file.selectable === "boolean" && typeof file.reason === "string")) {
    throw new Error("Context files unavailable. Update and restart Elpis, then retry.");
  }
  return { files: result.files };
}

/** Mounted only while this chat's Ledger is open; refresh also sees changes made in the terminal. */
export function ContextFiles({ threadId, onOpenFile, onReady }: { threadId: string; onOpenFile: () => void; onReady?: () => void }) {
  const [sources, setSources] = useState<Sources | null>(null), [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const request = useRef(0), writing = useRef(false), reading = useRef(false);
  const readController = useRef<AbortController | null>(null);
  const endpoint = `/threads/${encodeURIComponent(threadId)}/context-files`;
  const refresh = useCallback(async () => {
    if (writing.current || reading.current) return;
    reading.current = true;
    const controller = new AbortController(); readController.current = controller;
    const sequence = ++request.current;
    try {
      const value = sourcesOf(await readContext<unknown>(endpoint, controller.signal));
      if (sequence === request.current) { setSources(value); setError(""); }
    } catch (cause) { if (sequence === request.current) setError(message(cause)); }
    finally { if (readController.current === controller) { readController.current = null; reading.current = false; } }
  }, [endpoint]);
  useEffect(() => { if (sources || error) onReady?.(); }, [sources, error, onReady]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => { clearInterval(timer); request.current++; readController.current?.abort(); readController.current = null; reading.current = false; };
  }, [refresh]);
  const save = async (file: ContextFile, included: boolean) => {
    if (writing.current || !file.selectable) return;
    writing.current = true; setSaving(file.path); setError("");
    const sequence = ++request.current;
    try {
      const value = sourcesOf(await api<unknown>(endpoint, { path: file.path, included }));
      if (sequence === request.current) setSources(value);
    } catch (cause) { if (sequence === request.current) setError(message(cause)); }
    finally { writing.current = false; if (sequence === request.current) setSaving(null); }
  };
  const open = (file: ContextFile) => {
    if (openRef({ path: file.path })) onOpenFile();
    else setError("Open a project folder to view this file.");
  };
  return <div className="context-files" aria-label="Context files" aria-busy={saving !== null}>
    {!sources && !error && <p className="context-ledger-note" role="status">Loading context files…</p>}
    {error && <div className="context-files-error"><p role="alert">{error}</p><Button size="sm" variant="ghost" disabled={saving !== null} onClick={() => void refresh()}>Retry context files</Button></div>}
    {sources?.files.length === 0 && <p className="context-ledger-note">No portable context is available.</p>}
    {groups.map(([group, label]) => {
      const rows = sources?.files.filter(file => file.group === group) ?? [];
      if (!rows.length) return null;
      return <section key={group} aria-label={label}>
        <h3 className="context-files-heading">{label}</h3>
        <ul>{rows.map(file => <li key={file.path} data-context-path={file.path} data-included={file.included} title={file.reason}>
          <Switch size="sm" aria-label={`Include ${file.name}`} title={file.reason} checked={file.included} disabled={!file.selectable || saving !== null} onCheckedChange={included => void save(file, included)} />
          <div className="context-file-detail">
            <button type="button" className="context-file-name" title={file.path} aria-label={`Open ${file.name}`} onClick={() => open(file)}><bdi>{file.name}</bdi></button>
            <div className="context-file-meta"><span>≈{tokens(file.estimatedTokens)} est. tokens</span><span className="context-file-state">{saving === file.path ? "Saving…" : file.included ? "INCLUDED" : "EXCLUDED"}</span></div>
          </div>
        </li>)}</ul>
      </section>;
    })}
  </div>;
}
