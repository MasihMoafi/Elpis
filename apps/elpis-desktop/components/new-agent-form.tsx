"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { ModelPicker } from "@/components/model-picker";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, providerChoices, type Model, type ProviderSettings, type Thread } from "@/lib/api";

type Props = { models: Model[]; settings: ProviderSettings | null; defaultCwd: string; connected: boolean;
  onCreated: (thread: Thread, turnId: string | null, unsent?: string, error?: string) => void; onConfigure?: () => void };

/** A new agent is a native root thread with its own name, model, folder and developer instructions; it has no parent. */
export function NewAgentForm({ models, settings, defaultCwd, connected, onCreated, onConfigure }: Props) {
  const choices = providerChoices(models, settings);
  const [choiceId, setChoiceId] = useState("");
  const choice = choices.find(item => item.id === choiceId) ?? choices[0];
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [cwd, setCwd] = useState(defaultCwd);
  const [instructions, setInstructions] = useState("");
  const [first, setFirst] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [folderChooser, setFolderChooser] = useState(false);
  useEffect(() => { setFolderChooser(typeof window.elpisDesktop?.chooseFolder === "function"); }, []);

  async function chooseFolder() {
    try {
      const chosen = await window.elpisDesktop?.chooseFolder?.();
      if (chosen) { setCwd(chosen); setError(""); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  const needsModelId = !!choice?.provider;
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const { thread } = await api<{ thread: Thread }>("/threads", { name: name.trim(), ...(model.trim() ? { model: model.trim() } : {}),
        ...(choice?.provider ? { provider: choice.provider } : {}), ...(cwd.trim() ? { cwd: cwd.trim() } : {}), ...(instructions.trim() ? { instructions } : {}) });
      let turnId: string | null = null;
      if (first.trim()) {
        try { turnId = (await api<{ turn: { id: string } }>(`/threads/${encodeURIComponent(thread.id)}/turns`, { text: first })).turn.id; }
        catch (e) {
          onCreated(thread, null, first, `Conversation created, but its first message was not sent: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
      }
      onCreated(thread, turnId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  const ready = connected && !!name.trim() && (!needsModelId || !!model.trim()) && !busy;
  return <form aria-label="New agent" className="settings-page grid gap-5" onSubmit={submit}>
    <header><h2 className="text-lg font-semibold">New agent</h2><p className="text-sm text-muted-foreground">Starts a separate Elpis conversation with its own model, folder and instructions. Message it from its chat or the Agents page.</p></header>
    <section className="settings-card grid gap-4 p-4">
      <label className="field">Name<Input aria-label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="What this agent is for" maxLength={120} required /></label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="field">Model<ModelPicker choices={choices} models={models} model={model} choiceId={choiceId} defaultModel={settings?.main.model}
          disabled={busy} onConfigure={onConfigure} onChange={next => { setChoiceId(next.choiceId); setModel(next.model); }} /></label>
      </div>
      <label className="field">Working folder<div className="flex gap-2"><Input aria-label="Working folder" value={cwd} onChange={e => setCwd(e.target.value)} placeholder="Absolute path; leave empty for Elpis’s configured folder" maxLength={4096} disabled={busy} /><Button type="button" variant="outline" disabled={busy || !folderChooser} onClick={chooseFolder}>Choose folder</Button></div></label>
      <label className="field">Instructions<Textarea aria-label="Instructions" value={instructions} onChange={e => setInstructions(e.target.value)} placeholder="Added to Elpis's own instructions for every turn of this agent" rows={4} /></label>
      <label className="field">First message<Textarea aria-label="First message" value={first} onChange={e => setFirst(e.target.value)} placeholder="Optional: the task to start now" rows={3} /></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end"><Button type="submit" disabled={!ready || (choice?.id !== "" && !needsModelId && !model)}>{busy ? "Creating…" : "Create agent"}</Button></div>
    </section>
  </form>;
}
