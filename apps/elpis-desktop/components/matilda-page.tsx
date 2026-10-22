"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { CustomizeRow } from "@/components/customize-row";
import { SettingRow, SettingsActions, SettingsGroup, SettingsNotice } from "@/components/settings/rows";
import { api, title, type Thread } from "@/lib/api";
import { MATILDA, isMatildaChat, matildaChatName, matildaInstructions, matildaTaskOf } from "@/lib/matilda";
import "./matilda-page.css";

/** Matilda at the helm: show her a task, and she works on it in a chat of her own, alone or with up to two helper agents. */
export function MatildaPage({ cwd, threads, onOpenChat }: { cwd?: string; threads: Thread[]; onOpenChat: (id: string) => void }) {
  const [task, setTask] = useState(""), [helpers, setHelpers] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const recent = threads.filter(isMatildaChat).slice(0, 8);
  const give = async () => {
    const text = task.trim();
    if (!text || busy) return;
    setBusy(true); setError("");
    try {
      const { thread } = await api<{ thread: Thread }>("/threads", { ...(cwd ? { cwd } : {}), name: matildaChatName(text), instructions: matildaInstructions(helpers), ...(helpers ? { agents: true, maxAgents: MATILDA.helpers } : {}) });
      await api(`/threads/${encodeURIComponent(thread.id)}/turns`, { text });
      setTask(""); onOpenChat(thread.id);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <div className="customize matilda" aria-label="Matilda">
    <header className="matilda-head">
      {/* eslint-disable-next-line @next/next/no-img-element -- a 480 px webp from public/, in a static export */}
      <img className="matilda-portrait hud-cut" src={MATILDA.image} alt={`${MATILDA.name}'s portrait`} width={96} height={96} draggable={false} />
      <div className="matilda-intro">
        <h2>{MATILDA.name}</h2>
        <p>{MATILDA.role}</p>
        <p className="matilda-focus"><span className="hud-label">Now</span> {MATILDA.now} <span className="hud-label">Then</span> {MATILDA.next}</p>
      </div>
    </header>
    <SettingsGroup title="Give her a task">
      <div className="matilda-task">
        <Textarea aria-label="Task for Matilda" placeholder="What should Matilda work on? For example: draft a launch post for Rustidian." value={task} rows={5}
          onChange={event => setTask(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void give(); } }} />
      </div>
      <SettingRow title="Two helpers" description="She does the task herself. Turn this on and she may hand parts of it to up to two helper agents.">
        <Switch aria-label="Let Matilda use two helpers" checked={helpers} onCheckedChange={setHelpers} />
      </SettingRow>
      <SettingsActions feedback={error ? <SettingsNotice tone="alert">{error}</SettingsNotice> : undefined}>
        <Button disabled={!task.trim() || busy} onClick={() => void give()}>{busy ? "Giving the task…" : "Give Matilda the task"}</Button>
      </SettingsActions>
    </SettingsGroup>
    {recent.length > 0 && <SettingsGroup title="Her recent tasks">
      <ul className="customize-list">{recent.map(thread => <CustomizeRow key={thread.id} name={matildaTaskOf(title(thread))} description={thread.status?.type === "active" ? "Working on it" : undefined}>
        <Button variant="outline" onClick={() => onOpenChat(thread.id)}>Open</Button>
      </CustomizeRow>)}</ul>
    </SettingsGroup>}
  </div>;
}
