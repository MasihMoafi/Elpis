"use client";

import { useEffect, useRef, useState } from "react";
import { selectPaneContent } from "@/lib/pane-select";
import { api } from "@/lib/api";
import { readPersonalizationDraft, writePersonalizationDraft, type PersonalizationDraft } from "@/lib/personalization-drafts";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownText } from "@/components/markdown-text";
import { Segmented, SettingRow, SettingsActions, SettingsGroup, SettingsNotice } from "@/components/settings/rows";

type FileSnapshot = { path: string; content: string; version: string };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Drafts use the existing native workspace journal, independently of the engine files. */
export function FileSettings({ kind, label }: { kind: "instructions" | "memory"; label: string }) {
  const key = `elpis-draft-v1:settings-${kind}`, endpoint = `/settings/files/${kind}`;
  const [saved, setSaved] = useState<FileSnapshot | null>(null);
  const [draft, setDraft] = useState<PersonalizationDraft | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const current = useRef(draft); current.current = draft;
  function journal(value: PersonalizationDraft | null) {
    // Keep text in memory even if the device refuses to journal it.
    current.current = value; setDraft(value);
    try { writePersonalizationDraft(key, value); }
    catch (cause) { setError(`Could not preserve this draft: ${message(cause)}. Keep this window open.`); }
  }
  async function load() {
    setPending(true); setError(""); setNotice("");
    try {
      const file = await api<FileSnapshot>(endpoint);
      if (typeof file.content !== "string" || typeof file.version !== "string") throw Error("Could not read this file. Retry loading it.");
      setSaved(file);
      if (current.current?.content === file.content) journal(null);
      return true;
    } catch (cause) { setError(message(cause)); return false; }
    finally { setPending(false); }
  }
  useEffect(() => {
    try {
      const restored = readPersonalizationDraft(key);
      current.current = restored; setDraft(restored);
    } catch (cause) { setError(`Could not restore this draft: ${message(cause)}`); }
    void load();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    const value = current.current;
    if (!value || pending) return;
    setPending(true); setError(""); setNotice("");
    try {
      const file = await api<FileSnapshot>(endpoint, value);
      setSaved(file); journal(null); setNotice(`${label} saved.`);
    } catch (cause) { setError(message(cause)); }
    finally { setPending(false); }
  }
  async function reload() {
    if (current.current && !window.confirm(`Discard unsaved changes to ${label}?`)) return;
    if (await load()) journal(null);
  }
  const missing = saved?.version === "missing", text = draft?.content ?? saved?.content ?? "";
  return <SettingsGroup title={label}>
    <SettingRow stacked title={kind === "instructions" ? "AGENTS.md" : "memories/MEMORY.md"} description={saved ? missing ? `${saved.path} · not created yet` : saved.path : "Loading the engine’s file…"}>
      <div className="settings-field-stack">
        <Segmented label={`${label} view`} value={mode} options={[{ value: "edit", label: "Edit" }, { value: "preview", label: "Preview" }]} onChange={setMode} disabled={!saved} />
        {mode === "preview"
          ? <div aria-label={`${label} preview`} tabIndex={-1} onKeyDown={selectPaneContent} className="max-h-80 min-h-28 overflow-auto border border-border p-3 text-sm outline-none">{text.trim() ? <MarkdownText text={text} /> : <p className="text-muted-foreground">{missing ? "Not created yet. Switch to Edit and save to create it." : "Nothing written yet."}</p>}</div>
          : <Textarea aria-label={label} data-settings-file className="max-h-80 min-h-28 font-mono" disabled={pending || !saved} placeholder={missing ? "Not created yet. Write here and press Save to create it." : undefined} value={text} onChange={event => {
            setError(""); setNotice("");
            journal(event.target.value === saved?.content ? null : { content: event.target.value, version: draft?.version ?? saved!.version });
          }} onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void save(); }
          }} />}
      </div>
    </SettingRow>
    <SettingsActions feedback={error ? <SettingsNotice tone="alert">{error}</SettingsNotice> : <SettingsNotice>{notice || (draft ? "Unsaved changes · draft preserved on this device." : pending ? "Loading…" : "Saved changes apply to new chats.")}</SettingsNotice>}>
      <Button variant="ghost" aria-label={`Reload ${label}`} disabled={pending} onClick={() => void reload()}>Reload</Button>
      <Button aria-label={`Save ${label}`} disabled={pending || !draft || !saved} onClick={() => void save()}>{pending ? "Saving…" : "Save"}</Button>
    </SettingsActions>
  </SettingsGroup>;
}
