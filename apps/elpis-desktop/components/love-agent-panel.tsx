"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { characters, avatar, type Character, type LoveAgent } from "@/lib/love-agents";

export function CharacterPicker({ onAdd }: { onAdd: (character: Character) => void }) {
  return <DropdownMenuContent align="start" className="love-agent-picker" aria-label="Choose an agent">
    {characters.map(c => <DropdownMenuItem key={c.id} aria-label={`Add ${c.name}`} onClick={() => onAdd(c)}>
      {/* Portraits are generated locally; no account, image service or download. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="shrink-0" src={avatar(c)} alt="" width={40} height={40} /><span className="min-w-0 whitespace-normal wrap-break-word"><strong>{c.name}</strong><small>{c.detail}</small></span>
    </DropdownMenuItem>)}
  </DropdownMenuContent>;
}

export function LoveAgentPanel({ agent, busy, cwd, onChange, onRun, onClose, onOpenChat, onAnswer }: { agent: LoveAgent; busy: boolean; cwd?: string; onChange: (change: Partial<LoveAgent>) => void; onRun: () => void; onClose: () => void; onOpenChat?: (id: string) => void; onAnswer?: (optionId: string) => void }) {
  const [draft, setDraft] = useState(agent);
  useEffect(() => setDraft(agent), [agent]);
  const field = (key: "task" | "prompt" | "model" | "provider", value: string) => { setDraft(a => ({ ...a, [key]: value })); onChange({ [key]: value }); };
  const character = characters.find(c => c.id === agent.preset) ?? characters[0];
  return <aside className="love-agent-panel" aria-label="Agent details" onKeyDown={e => e.stopPropagation()}>
    <div className="love-agent-heading">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={avatar(character)} alt="" width={48} height={48} /><div><strong>{agent.name}</strong><small>Behind the character</small></div>
      <Button variant="ghost" size="sm" onClick={onClose}>Done</Button>
    </div>
    <label>Task<textarea aria-label="Task" rows={3} value={draft.task} maxLength={16000} onChange={e => field("task", e.target.value)} /></label>
    <label>Prompt<textarea aria-label="Prompt" rows={5} value={draft.prompt} maxLength={32000} onChange={e => field("prompt", e.target.value)} /></label>
    <label>Model<input aria-label="Model" value={draft.model} maxLength={200} onChange={e => field("model", e.target.value)} /></label>
    <label>Provider<input aria-label="Provider" value={draft.provider} maxLength={200} onChange={e => field("provider", e.target.value)} /></label>
    <p><strong>Tools</strong> · The agent&apos;s own tools; it runs as an ACP agent. When it asks permission to act, the question appears here.</p>
    {cwd && <p>Working folder: {cwd}</p>}
    <p>Draw an arrow between cards to pass the first answer to the next agent.</p>
    <Button disabled={busy} onClick={onRun}>{busy ? "Agents running…" : "Run connected agents"}</Button>
    {agent.status && <p role="status">{agent.status === "failed" ? agent.error : agent.status === "waiting" ? "Waiting for your answer" : agent.status}</p>}
    {agent.permission && <div role="group" aria-label="Permission request" className="flex flex-col gap-2 rounded-md border border-border p-3">
      <strong className="wrap-anywhere">{agent.permission.title}</strong>
      <div className="flex flex-wrap gap-2">{agent.permission.options.map(option => <Button key={option.optionId} size="sm" variant={option.kind.startsWith("allow") ? "default" : "outline"} onClick={() => onAnswer?.(option.optionId)}>{option.name}</Button>)}</div>
    </div>}
    {agent.threadId && (onOpenChat ? <Button variant="outline" onClick={() => onOpenChat(agent.threadId!)}>Open its chat</Button> : <a href={`/?session=${encodeURIComponent(agent.threadId)}`}>Open its chat</a>)}
    {agent.output && <div role="region" aria-label="Answer" className="love-agent-answer">{agent.output}</div>}
  </aside>;
}
