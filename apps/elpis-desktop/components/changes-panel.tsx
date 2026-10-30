"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileDiff, RefreshCw, Undo2 } from "lucide-react";
import { FolderIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { api, unreadable } from "@/lib/api";
import { parseDiff } from "@/lib/diff";
import { FileRefLink } from "@/components/file-ref";
import { Counts, DIFF_LINE_LIMIT, DiffLines } from "@/components/diff-view";
import "@/components/changes-panel.css";

type Status = "modified" | "added" | "deleted" | "untracked" | "conflicted";
type Change = { path: string; status: Status; added: number; removed: number; binary: boolean };
/** `recorded`: the folder has no Git, so the list is the edits this chat recorded (bridge/recorded-changes.mjs). */
type ChangeList = { root: string; files: Change[]; truncated: boolean; recorded?: boolean };
type FileDiff = { diff: string; truncated: boolean; binary: boolean };

/** While a turn runs the agent keeps editing, so the list is read again this often. */
const POLL_MS = 1500;
const LABEL: Record<Status, string> = { modified: "Modified", added: "Added", deleted: "Deleted", untracked: "Untracked", conflicted: "Conflicted" };
const LETTER: Record<Status, string> = { modified: "M", added: "A", deleted: "D", untracked: "U", conflicted: "C" };
const WARNING: Record<Status, string> = {
  modified: "The file goes back to its last committed version and your changes to it are lost.",
  added: "The file leaves the folder and the staging area.",
  untracked: "The new file is deleted from the folder.",
  deleted: "The file comes back as it was in the last commit.",
  conflicted: "The file goes back to its last committed version and the merge result is lost.",
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const pathOf = (root: string, file: string) => file.startsWith("/") ? file : `${root.replace(/\/+$/, "")}/${file}`;
const folderOf = (root: string, file: string) => { const full = pathOf(root, file); return full.slice(0, full.lastIndexOf("/")) || "/"; };

/** The side panel's Changes tab, the review surface: the chat's working-tree changes against the last commit (outside Git,
 * the edits the chat recorded), a list of files and the open file's diff. It reads while a turn runs and once when it ends. Discard is the only write, one file at
 * a time and only after a confirmation; nothing here commits, pushes or opens a pull request. */
export function ChangesPanel({ threadId, running }: { threadId: string | undefined; running: boolean }) {
  const [list, setList] = useState<ChangeList | null>(null), [error, setError] = useState(""), [note, setNote] = useState("");
  const [diff, setDiff] = useState<{ path: string; value?: FileDiff; error?: string } | null>(null);
  const [confirming, setConfirming] = useState<Change | null>(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState("");
  const picked = useRef<string | null>(null), latest = useRef(0), loading = useRef(false), chat = useRef(threadId);
  chat.current = threadId;
  const base = threadId ? `/threads/${encodeURIComponent(threadId)}/git` : "";
  const readDiff = useCallback(async (path: string) => {
    const mine = threadId;
    try {
      const value = await api<FileDiff>(`${base}?view=file&path=${encodeURIComponent(path)}`);
      if (chat.current === mine && picked.current === path) setDiff({ path, value });
    } catch (cause) { if (chat.current === mine && picked.current === path) setDiff({ path, error: message(cause) }); }
  }, [base, threadId]);
  /** The list, then the open file's diff (the first file when none is open or it has no changes any more). */
  const load = useCallback(async (force = false) => {
    if (!threadId || (loading.current && !force)) return;
    loading.current = true; const run = ++latest.current;
    try {
      const next = await api<ChangeList>(`${base}?view=changes`);
      if (run !== latest.current || chat.current !== threadId) return;
      if (!Array.isArray(next.files)) throw unreadable("changes");
      setList(next); setError("");
      picked.current = next.files.find(file => file.path === picked.current)?.path ?? next.files[0]?.path ?? null;
      if (picked.current) await readDiff(picked.current); else setDiff(null);
    } catch (cause) { if (run === latest.current) setError(message(cause)); }
    finally { loading.current = false; }
  }, [base, threadId, readDiff]);
  useEffect(() => { setList(null); setDiff(null); setError(""); picked.current = null; loading.current = false; void load(); }, [load]);
  useEffect(() => { if (!threadId || !running) return; const timer = setInterval(() => void load(), POLL_MS); return () => clearInterval(timer); }, [threadId, running, load]);
  const wasRunning = useRef(running);
  useEffect(() => { if (wasRunning.current && !running) void load(true); wasRunning.current = running; }, [running, load]);

  const shown = list?.files.find(file => file.path === picked.current) ?? list?.files[0] ?? null;
  const open = (file: Change) => { picked.current = file.path; setDiff(null); setNote(""); void readDiff(file.path); };
  const discard = async () => {
    if (!confirming) return;
    setBusy(true); setFailure("");
    try { await api(base, { action: "discard", path: confirming.path }); setConfirming(null); await load(true); }
    catch (cause) { setFailure(message(cause)); }
    finally { setBusy(false); }
  };
  const showInFolder = (file: Change) => {
    const openFolder = window.elpisDesktop?.openFolder;
    if (list && openFolder) openFolder(folderOf(list.root, file.path)).then(() => setNote(""), cause => setNote(message(cause)));
  };
  const added = list?.files.reduce((sum, file) => sum + file.added, 0) ?? 0, removed = list?.files.reduce((sum, file) => sum + file.removed, 0) ?? 0;
  const current = diff?.path === shown?.path ? diff : null, lines = current?.value ? parseDiff(current.value.diff) : null;
  return <div className="changes">
    <div className="changes-head">
      <span className="changes-summary">{list ? list.files.length ? <>{list.files.length === 1 ? "1 file changed" : `${list.files.length} files changed`}{list.truncated ? " (first 200)" : ""} <Counts added={added} removed={removed} /></> : "No changes" : "Changes"}</span>
      <Button type="button" variant="ghost" size="icon-xs" className="side-action" aria-label="Refresh changes" title="Read the changes again" disabled={!threadId} onClick={() => void load(true)}><RefreshCw size={16} /></Button>
    </div>
    {!threadId ? <p className="changes-note">Open a chat to see the changes in its folder.</p>
      : error ? <p role="alert" className="changes-note changes-error">{error}</p>
      : !list ? <p role="status" className="changes-note">Reading the changes…</p>
      : !list.files.length ? <p className="changes-note">{list.recorded ? "This chat has not edited any file here yet." : "No changes in this folder."}</p>
      : <>
        {list.recorded && <p className="changes-note">This folder has no Git, so these are the edits this chat made.</p>}
        <ul className="change-list" aria-label="Changed files">{list.files.map(file => <li key={file.path}>
          <FileRefLink target={{ path: pathOf(list.root, file.path) }} label={file.path} className="change-row" current={file.path === shown?.path}>
            <span className="change-status" data-status={file.status} title={LABEL[file.status]}>{LETTER[file.status]}</span>
            <span className="change-path" title={file.path}>{file.path.includes("/") && <span className="dir">{file.path.slice(0, file.path.lastIndexOf("/") + 1)}</span>}{file.path.slice(file.path.lastIndexOf("/") + 1)}</span>
            {file.binary ? <span className="change-counts">binary</span> : <Counts added={file.added} removed={file.removed} />}
          </FileRefLink>
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`View diff of ${file.path}`} title={`View diff of ${file.path}`} onClick={() => open(file)}><FileDiff size={16} /></Button>
        </li>)}</ul>
        {shown && <section className="diff-view" aria-label={`Diff of ${shown.path}`}>
          <div className="diff-head">
            <span className="diff-title" title={shown.path}><FileRefLink target={{ path: pathOf(list.root, shown.path) }}>{shown.path}</FileRefLink></span>
            {window.elpisDesktop?.openFolder && <Button type="button" variant="ghost" size="xs" onClick={() => showInFolder(shown)}><FolderIcon size={16} aria-hidden="true" />Show in folder</Button>}
            {!list.recorded && <Button type="button" variant="destructive" size="xs" disabled={running} title={running ? "Wait for the turn to finish" : `Throw away the changes to ${shown.path}`} onClick={() => { setFailure(""); setConfirming(shown); }}><Undo2 size={16} aria-hidden="true" />Discard</Button>}
          </div>
          {note && <p role="alert" className="changes-note changes-error">{note}</p>}
          <div className="diff-body" tabIndex={0}>
            {current?.error ? <p role="alert" className="changes-note changes-error">{current.error}</p>
              : !lines ? <p role="status" className="changes-note">Reading the diff…</p>
              : current?.value?.binary ? <p className="changes-note">{list.recorded ? "A binary file; no text lines were recorded." : "A binary file; Git shows no lines."}</p>
              : !lines.length ? <p className="changes-note">No lines to show.</p>
              : <><DiffLines lines={lines} path={pathOf(list.root, shown.path)} plain={list.recorded} />
                {(lines.length > DIFF_LINE_LIMIT || current?.value?.truncated) && <p className="changes-note">Showing the first part only; the diff is larger than this view keeps.</p>}</>}
          </div>
        </section>}
      </>}
    <AlertDialog open={!!confirming} onOpenChange={next => { if (!next && !busy) setConfirming(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes to {confirming?.path}?</AlertDialogTitle>
          <AlertDialogDescription>{confirming && WARNING[confirming.status]} This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
        <AlertDialogFooter>
          <AlertDialogClose render={<Button type="button" variant="outline" disabled={busy} />}>Cancel</AlertDialogClose>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void discard()}>{busy ? "Discarding…" : "Discard changes"}</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>;
}
