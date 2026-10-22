"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, title, type Thread } from "@/lib/api";
import { MARKETER, MATILDA, isMatildaChat, matildaChatName, matildaInstructions, matildaTaskOf } from "@/lib/matilda";
import { appStorage } from "@/lib/projects";
import "./matilda-panel.css";

const PERSONA_KEY = "elpis-matilda-persona";
const savedPersona = () => { try { return appStorage().getItem(PERSONA_KEY) || MARKETER; } catch { return MARKETER; } };

/** Matilda's panel beside the Love Spot board, in the place Talk uses: show her a task, and she works on it in a chat of her own, alone or
 * with up to two helper agents. "Who she is" is hers to rewrite; it starts as the marketer. */
export function MatildaPanel({ open, onClose, cwd, threads, onOpenChat }: { open: boolean; onClose: () => void; cwd?: string; threads: Thread[]; onOpenChat: (id: string) => void }) {
  const [task, setTask] = useState(""), [helpers, setHelpers] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [persona, setPersona] = useState(savedPersona);
  const recent = threads.filter(isMatildaChat).slice(0, 6);
  const keepPersona = (value: string) => { try { appStorage().setItem(PERSONA_KEY, value); } catch { /* Who she is is a convenience. */ } };
  const give = async () => {
    const text = task.trim();
    if (!text || busy) return;
    setBusy(true); setError("");
    try {
      const { thread } = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), name: matildaChatName(text), instructions: matildaInstructions(helpers, persona), ...(helpers ? { agents: true, maxAgents: MATILDA.helpers } : {}) });
      await api(`/threads/${encodeURIComponent(thread.id)}/turns`, { text });
      setTask(""); onOpenChat(thread.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section role="region" aria-label="Matilda" hidden={!open} className="love-spot-talk matilda-panel" onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header className="love-spot-talk-heading">
      <span className="matilda-title">
        {/* eslint-disable-next-line @next/next/no-img-element -- a 480 px webp from public/, in a static export */}
        <img className="matilda-portrait hud-cut" src={MATILDA.image} alt={`${MATILDA.name}'s portrait`} width={40} height={40} draggable={false} />
        <strong>{MATILDA.name}</strong>
      </span>
      <Button variant="ghost" size="icon-sm" aria-label="Fold Matilda" onClick={onClose}><ChevronDown size={16} /></Button>
    </header>
    <div className="matilda-body">
      <label className="matilda-field">Give her a task
        <Textarea aria-label="Task for Matilda" placeholder="What should Matilda work on?" value={task} rows={5} onChange={event => setTask(event.target.value)}
          onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void give(); } }} />
      </label>
      <label className="matilda-row"><span>Two helpers<small>She may hand parts of the task to up to two helper agents.</small></span>
        <Switch aria-label="Let Matilda use two helpers" checked={helpers} onCheckedChange={setHelpers} />
      </label>
      {error && <p role="alert" className="love-spot-talk-error">{error}</p>}
      <Button disabled={!task.trim() || busy} onClick={() => void give()}>{busy ? "Giving the task…" : "Give Matilda the task"}</Button>
      <details className="matilda-persona">
        <DisclosureSummary>Who she is</DisclosureSummary>
        <label className="matilda-field">Tell her who to be
          <Textarea aria-label="Who Matilda is" value={persona} rows={8} onChange={event => setPersona(event.target.value)} onBlur={() => keepPersona(persona)} />
        </label>
        <Button variant="outline" size="sm" disabled={persona === MARKETER} onClick={() => { setPersona(MARKETER); keepPersona(MARKETER); }}>Back to the marketer</Button>
      </details>
      {recent.length > 0 && <div className="matilda-recent"><strong>Her recent tasks</strong>
        <ul>{recent.map(thread => <li key={thread.id}><span title={matildaTaskOf(title(thread))}>{matildaTaskOf(title(thread))}</span><Button variant="outline" size="sm" onClick={() => onOpenChat(thread.id)}>Open</Button></li>)}</ul>
      </div>}
    </div>
  </section>;
}
