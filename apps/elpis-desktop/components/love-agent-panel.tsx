"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dictation } from "@/components/dictation";
import { insertTranscript } from "@/lib/dictation";
import { DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { characters, avatar, type Character, type LoveAgent } from "@/lib/love-agents";

export function CharacterPicker({ onAdd }: { onAdd: (character: Character) => void }) {
  return <DropdownMenuContent align="start" className="love-agent-picker" aria-label="Choose an agent">
    {characters.map(c => <DropdownMenuItem key={c.id} aria-label={`Add ${c.name}`} onClick={() => onAdd(c)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="shrink-0" src={avatar(c)} alt="" width={72} height={72} /><span className="min-w-0 whitespace-normal wrap-break-word"><strong>{c.name}</strong><small>{c.detail}</small></span>
    </DropdownMenuItem>)}
  </DropdownMenuContent>;
}

export function LoveAgentPanel({ agent, busy, cwd, onChange, onInterview, onRun, onClose, onOpenChat, onAnswer }: { agent: LoveAgent; busy: boolean; cwd?: string; onChange: (change: Partial<LoveAgent>) => void; onInterview: (message?: string) => Promise<boolean>; onRun: (confirm?: boolean) => void; onClose: () => void; onOpenChat?: (id: string) => void; onAnswer?: (optionId: string) => void }) {
  const [draft, setDraft] = useState(agent);
  const [reply, setReply] = useState(""), [sending, setSending] = useState(false), [dictating, setDictating] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null), messages = useRef<HTMLDivElement>(null);
  const began = useRef(false), ask = useRef(onInterview); ask.current = onInterview;
  const interview = agent.interview;
  const waiting = sending || !!interview?.busy;
  useEffect(() => {
    if (!began.current && interview && (!interview.messages.length || interview.busy) && !interview.error) { began.current = true; void ask.current(); }
  }, [interview]);
  useEffect(() => { messages.current?.scrollTo({ top: messages.current.scrollHeight }); }, [interview?.messages.length, interview?.proposal]);
  const send = async (retry = false) => {
    if (waiting || busy || dictating) return;
    if (!retry && !reply.trim()) { if (interview?.proposal && !interview.approved) onRun(true); return; }
    setSending(true);
    try { if (await onInterview(retry ? undefined : reply.trim())) setReply(""); }
    finally { setSending(false); input.current?.focus(); }
  };
  useEffect(() => setDraft(agent), [agent]);
  const field = (key: "task" | "prompt" | "model" | "provider", value: string) => { setDraft(a => ({ ...a, [key]: value })); onChange({ [key]: value }); };
  const character = characters.find(c => c.id === agent.preset) ?? characters[0];
  return <aside className="love-agent-panel" aria-label="Agent details" onKeyDown={e => e.stopPropagation()}>
    <div className="love-agent-heading">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={avatar(character)} alt="" width={64} height={64} /><div><strong>{agent.name}</strong><small>{character.detail}</small></div>
      <Button variant="ghost" size="sm" onClick={onClose}>Done</Button>
    </div>
    {interview && <>
      <div ref={messages} role="log" aria-label={`${agent.name} interview`} aria-live="polite" className="love-agent-conversation">
        {interview.messages.map((message, i) => <div key={i} className={`chat ${message.role === "user" ? "chat-end" : "chat-start"}`}>
          <div className="chat-header">{message.role === "user" ? "You" : agent.name}</div><div className="chat-bubble">{message.text}</div>
        </div>)}
        {waiting && <p role="status">{agent.name} is thinking…</p>}
      </div>
      {interview.error && <div role="alert">{interview.error}<Button className="btn btn-sm" variant="outline" disabled={waiting} onClick={() => void send(true)}>Retry question</Button></div>}
      {interview.proposal && !interview.approved && <div className="rounded-box border border-border bg-muted p-3" aria-label="Proposed task"><small>Proposed task</small><p className="font-medium text-foreground">{interview.proposal}</p><Button className="btn btn-sm" disabled={waiting || busy || dictating} onClick={() => onRun(true)}>Start</Button><small className="block mt-2">Enter to start · or reply to refine it</small></div>}
      <form onSubmit={event => { event.preventDefault(); void send(); }} className="grid gap-2">
        <label className="sr-only" htmlFor="love-agent-reply">Reply to {agent.name}</label>
        <textarea ref={input} id="love-agent-reply" className="textarea textarea-sm" aria-label={`Reply to ${agent.name}`} rows={2} value={reply} maxLength={16000} placeholder={interview.proposal ? "Refine the task, or Enter to start" : "Your answer…"} disabled={waiting || busy} onChange={event => setReply(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        }} />
        <div className="flex flex-wrap items-center gap-2">
          <Dictation provider={agent.provider} disabled={waiting || busy} onBusy={setDictating} selection={() => ({ text: reply, start: input.current?.selectionStart ?? reply.length, end: input.current?.selectionEnd ?? reply.length })} onTranscript={(selection, text) => { setReply(current => insertTranscript(current, selection, text).text); input.current?.focus(); }} purpose="Answers this agent. Review, then send." />
          <Button className="btn btn-sm ml-auto" type="submit" disabled={waiting || busy || dictating || !reply.trim() || !interview.messages.length}>Send reply</Button>
        </div>
      </form>
    </>}
    <details className="rounded-box border border-border">
      <summary>Agent settings</summary>
      <div className="grid gap-3">
        <label>Task<textarea className="textarea textarea-sm" aria-label="Task" rows={3} value={draft.task} maxLength={16000} onChange={e => field("task", e.target.value)} /></label>
        <label>Prompt<textarea className="textarea textarea-sm" aria-label="Prompt" rows={5} value={draft.prompt} maxLength={32000} onChange={e => field("prompt", e.target.value)} /></label>
        <label>Model<input aria-label="Model" value={draft.model} maxLength={200} onChange={e => field("model", e.target.value)} /></label>
        <label>Provider<input aria-label="Provider" value={draft.provider} maxLength={200} onChange={e => field("provider", e.target.value)} /></label>
        <p>The agent runs over ACP with its own tools. Permission questions appear here.</p>
      </div>
    </details>
    {cwd && <p>Working folder: {cwd}</p>}
    <p>Draw an arrow between cards to pass the first answer to the next agent.</p>
    <Button className="btn btn-sm" disabled={busy || waiting || (!agent.task.trim() && !!interview)} onClick={() => onRun()}>{busy ? "Agents running…" : "Run connected agents"}</Button>
    {agent.status && <p role="status">{agent.status === "failed" ? agent.error : agent.status === "waiting" ? "Waiting for your answer" : agent.status}</p>}
    {agent.permission && <div role="group" aria-label="Permission request" className="flex flex-col gap-2 rounded-md border border-border p-3">
      <strong className="wrap-anywhere">{agent.permission.title}</strong>
      <div className="flex flex-wrap gap-2">{agent.permission.options.map(option => <Button key={option.optionId} size="sm" variant={option.kind.startsWith("allow") ? "default" : "outline"} onClick={() => onAnswer?.(option.optionId)}>{option.name}</Button>)}</div>
    </div>}
    {agent.threadId && (onOpenChat ? <Button variant="outline" onClick={() => onOpenChat(agent.threadId!)}>Open its chat</Button> : <a href={`/?session=${encodeURIComponent(agent.threadId)}`}>Open its chat</a>)}
    {agent.output && <div role="region" aria-label="Answer" className="love-agent-answer">{agent.output}</div>}
  </aside>;
}
