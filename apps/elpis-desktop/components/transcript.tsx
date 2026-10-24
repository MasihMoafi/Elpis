"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { CollapseDetails } from "@/components/step";
import { WorkingMark } from "@/components/working-mark";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { pruneOf } from "@/lib/smart-prune";
import type { Entry, Item } from "@/lib/api";
import { elapsed, reasoningOf, stepLabel, summarize, summaryParts } from "@/lib/steps";
import { CreatedFiles, ImageThumb, fileKind } from "@/components/file-cards";
import { Counts } from "@/components/diff-view";
import { TurnChanges } from "@/components/edit-rows";
import { turnEdits } from "@/lib/diff";

/** The conversation as the ChatGPT app shows it: each user message, then the turn's work
 * collapsed into short activity lines, and once a turn ends everything before its final reply
 * folds into "Worked for …". `renderItem` draws one message or activity in full; `mediaOf` is where the bridge serves
 * an item's recorded pictures (lib/api.ts `mediaUrl`). */
type Draw = { renderItem: (entry: Entry) => ReactNode; mediaOf?: (entry: Entry) => string | undefined };
export function Transcript({ entries, activeTurnId, onViewChanges, ...draw }: { entries: Entry[]; activeTurnId: string | null; onViewChanges?: () => void } & Draw) {
  const turns = turnsOf(entries);
  return <>{turns.map((turn, index) => {
    const start = turn.entries[0]?.startedAtMs, before = turns[index - 1]?.entries.at(-1), end = before?.completedAtMs ?? before?.startedAtMs;
    const pause = typeof start === "number" && typeof end === "number" && (start - end >= HOUR || new Date(start).toDateString() !== new Date(end).toDateString());
    return <Fragment key={turn.clientKey ?? turn.id}>
      {pause && <div className="turn-time"><time dateTime={new Date(start).toISOString()}>{turnTime(start)}</time></div>}
      <Turn turn={turn} active={turn.id === activeTurnId} onViewChanges={onViewChanges} {...draw} />
    </Fragment>;
  })}
    {activeTurnId && !turns.some(turn => turn.id === activeTurnId) && <div className="turn-working" role="status"><LiveStep key={activeTurnId} label="Working" /></div>}
  </>;
}

const HOUR = 3_600_000;
/** ChatGPT's time line ("Yesterday 8:41 PM") above a turn that starts an hour or more after the one before, or on another day. */
export function turnTime(at: number, now = new Date()): string {
  const date = new Date(at), time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const midnight = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(date)) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) })}, ${time}`;
}

type TurnEntries = { id: string; clientKey?: string; entries: Entry[] };
/** Elpis's answer: its message, or the review that /review ends with. */
const isReply = (item: Item) => item.type === "agentMessage" || item.type === "exitedReviewMode";
const isCompaction = (item: Item) => item.type === "contextCompaction" || item.type === "commandExecution" && item.command === "Compact conversation" && item.status === "completed";

function turnsOf(entries: Entry[]): TurnEntries[] {
  const turns: TurnEntries[] = [];
  const byId = new Map<string, TurnEntries>();
  for (const entry of entries) {
    let turn = byId.get(entry.turnId);
    if (!turn) { turn = { id: entry.turnId, entries: [] }; byId.set(entry.turnId, turn); turns.push(turn); }
    turn.entries.push(entry);
    if (entry.clientTurnKey) turn.clientKey = entry.clientTurnKey;
  }
  return turns;
}

/** The files a turn created and did not delete again, in the order it made them. */
function createdFiles(entries: Entry[]): string[] {
  const made = new Set<string>();
  for (const { item } of entries) if (item.type === "fileChange" && Array.isArray(item.changes)) for (const change of item.changes as { path?: unknown; kind?: { type?: unknown } }[]) {
    if (typeof change.path !== "string") continue;
    if (change.kind?.type === "add") made.add(change.path); else if (change.kind?.type === "delete") made.delete(change.path);
  }
  return [...made];
}

function Turn({ turn, active, onViewChanges, renderItem, mediaOf }: { turn: TurnEntries; active: boolean; onViewChanges?: () => void } & Draw) {
  const [workOpen, setWorkOpen] = useState(false);
  const ordered = withPrunes(turn.entries);
  // Older Claude saves represented /compact as a prompt and a synthetic tool call.
  // Its summary changes the model's context, while the conversation remains intact.
  const compact = ordered.find(entry => isCompaction(entry.item));
  const compactOnly = compact && ordered.every(entry => {
    if (entry === compact) return true;
    if (entry.item.type === "agentMessage") return !entry.item.text;
    return entry.item.type === "userMessage" && entry.item.content?.every(part => part.type === "text" && /^\/compact(?:\s|$)/.test(part.text ?? ""));
  });
  if (!active && compact && compactOnly) {
    return <section className="turn" aria-label="Turn">{renderItem({ ...compact, item: { id: compact.item.id, type: "contextCompaction" } })}</section>;
  }
  // The prompt that started the turn heads it; a message sent while it ran (a steer) stays where it was sent.
  const prompt = ordered.findIndex(entry => entry.item.type === "userMessage");
  const leading = prompt < 0 ? 0 : ordered.findIndex((entry, index) => index > prompt && entry.item.type !== "userMessage");
  const users = prompt < 0 ? [] : ordered.slice(0, leading < 0 ? ordered.length : leading).filter(entry => entry.item.type === "userMessage");
  const work = ordered.filter(entry => !users.includes(entry));
  // A proposed plan is the turn's answer as much as its last reply, so neither folds away.
  const lastReply = findLastIndex(work, entry => isReply(entry.item)), plan = work.findIndex(entry => entry.item.type === "plan");
  const finalReply = active ? -1 : plan >= 0 && (lastReply < 0 || plan < lastReply) ? plan : lastReply;
  // Work before the final answer folds away, but never past a message the person sent while it ran.
  const lastSent = findLastIndex(work.slice(0, Math.max(finalReply, 0)), entry => entry.item.type === "userMessage");
  const beforeCompaction = work.findIndex(entry => isCompaction(entry.item));
  const foldEnd = Math.min(lastSent >= 0 ? lastSent : finalReply, beforeCompaction < 0 ? work.length : beforeCompaction);
  const folded = foldEnd > 0 ? work.slice(0, foldEnd) : [];
  const visible = foldEnd > 0 ? work.slice(foldEnd) : work;
  return <section className="turn" aria-label="Turn" data-prompt={users.length > 0 ? "" : undefined}>
    {users.map(renderItem)}
    {folded.length > 0 && <details className="worked-for" onToggle={event => { if (event.target === event.currentTarget) setWorkOpen(event.currentTarget.open); }}>
      {/* Without recorded times, ChatGPT's "41 previous messages" says what the fold holds. */}
      <DisclosureSummary><span>{turn.entries.some(entry => typeof entry.startedAtMs === "number") ? workedFor(turn.entries) : `${folded.length} previous ${folded.length === 1 ? "message" : "messages"}`}</span></DisclosureSummary>
      {workOpen && <div className="worked-for-body"><Flow entries={folded} renderItem={renderItem} mediaOf={mediaOf} /></div>}
    </details>}
    <Flow entries={visible} renderItem={renderItem} mediaOf={mediaOf} live={active} />
    {!active && <CreatedFiles paths={createdFiles(work)} />}
    {!active && <TurnChanges items={work.map(entry => entry.item)} onViewChanges={onViewChanges} />}
    {/* One live line at a time: a running step shows its own; otherwise the turn says it is working. */}
    {active && !work.some(entry => entry.item.status === "inProgress") && <div className="turn-working" role="status"><LiveStep label="Working" since={earliest(turn.entries)} /></div>}
  </section>;
}

/** Replies stay as they are; each run of tool activity between them becomes one line. */
function Flow({ entries, renderItem, mediaOf, live = false }: { entries: Entry[]; live?: boolean } & Draw) {
  const blocks: ReactNode[] = [];
  let run: Entry[] = [];
  const flush = () => {
    if (run.length) blocks.push(<ActivityGroup key={`group-${run[0].item.id}`} entries={run} renderItem={renderItem} mediaOf={mediaOf} live={live} />);
    run = [];
  };
  for (const entry of entries) {
    if (isCompaction(entry.item)) {
      flush();
      blocks.push(<div key={entry.item.id}>{renderItem({ ...entry, item: { id: entry.item.id, type: "contextCompaction" } })}</div>);
    } else if (isReply(entry.item) || entry.item.type === "userMessage" || entry.item.type === "plan" || (entry.item.type === "commandExecution" && entry.item.source === "userShell")) {
      flush();
      blocks.push(<div key={entry.item.id}>{renderItem(entry)}</div>);
    } else run.push(entry);
  }
  flush();
  return <>{blocks}</>;
}

/** A run of tool activity as one muted row: what is running now, with its timer, or once finished what was done
 * ("Ran 2 commands (1 failed)") and the lines it added and removed ("+3 −1"), with the images it viewed as thumbnails, as
 * Claude's rows have them. Collapsed until opened by click, Enter or Space. */
function ActivityGroup({ entries, renderItem, mediaOf, live }: { entries: Entry[]; live: boolean } & Draw) {
  const [open, setOpen] = useState(false);
  const items = entries.filter(entry => entry.item.type !== "smartPrune").map(entry => entry.item);
  const running = live ? entries.find(entry => entry.item.status === "inProgress") : undefined;
  const views = entries.filter(entry => entry.item.type === "imageView" && typeof entry.item.path === "string" && mediaOf?.(entry)).slice(0, 3);
  const edits = running ? null : turnEdits(items);
  // A blank reasoning step says "no summary recorded" only when the group has no recorded reasoning to show.
  const recorded = items.some(item => item.type === "reasoning" && reasoningOf(item));
  const shown = recorded ? entries.filter(entry => entry.item.type !== "reasoning" || reasoningOf(entry.item)) : entries;
  return <details className="activity-group" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open); }}>
    <DisclosureSummary aria-expanded={open}>
      {running
        ? <LiveStep key={running.item.id} label={stepLabel(running.item, true)} since={running.startedAtMs} />
        : <span className="activity-group-label">{summaryParts(items).map((part, index) => <Fragment key={index}>{index > 0 && ", "}{part.text}{part.failed > 0 && <> <span className="activity-group-failed">({part.failed} failed)</span></>}</Fragment>)}</span>}
      {edits && edits.added + edits.removed > 0 && <Counts added={edits.added} removed={edits.removed} />}
      {views.map(entry => <ImageThumb key={entry.item.id} src={`${mediaOf!(entry)}/0`} name={fileKind(String(entry.item.path)).name} />)}
    </DisclosureSummary>
    {open && <div className="activity-group-body">{shown.map(entry => <div key={entry.item.id}>{renderItem(entry)}</div>)}<CollapseDetails label="Collapse tool calls" /></div>}
  </details>;
}

/** The timer is not drawn for a step's first seconds, as in Claude's rows. */
const TIMER_FROM_MS = 2000;
/** Something in progress, as a sentence with animated dots and a timer counting from `since` (else from now). */
function LiveStep({ label, since }: { label: string; since?: number }) {
  const [start] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <>
    <WorkingMark />
    <span className="live-label">{label}</span>
    {now - start >= TIMER_FROM_MS && <>{" "}<span className="live-timer">{elapsed(now - start)}</span></>}
  </>;
}

export { summarize };

/** "Worked for 14m 42s": from the user's message to the last recorded item. */
export function workedFor(entries: Entry[]): string {
  const starts = entries.map(entry => entry.startedAtMs).filter((value): value is number => typeof value === "number");
  const ends = entries.map(entry => entry.completedAtMs ?? entry.startedAtMs).filter((value): value is number => typeof value === "number");
  if (!starts.length || !ends.length) return "Worked";
  const seconds = Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  const label = hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  return `Worked for ${label}`;
}

function earliest(entries: Entry[]): number | undefined {
  const starts = entries.map(entry => entry.startedAtMs).filter((value): value is number => typeof value === "number");
  return starts.length ? Math.min(...starts) : undefined;
}

function findLastIndex<T>(values: T[], test: (value: T) => boolean): number {
  for (let index = values.length - 1; index >= 0; index--) if (test(values[index])) return index;
  return -1;
}


/** Batch decisions arrive after all sibling outputs; display each immediately below its call. */
function withPrunes(entries: Entry[]): Entry[] {
  const prunes = entries.filter(entry => entry.item.type === "smartPrune");
  const calls = new Set(entries.filter(entry => entry.item.type !== "smartPrune").map(entry => entry.item.id));
  return entries.filter(entry => entry.item.type !== "smartPrune").flatMap(entry => [entry,
    ...prunes.filter(prune => pruneOf(prune.item.prune)?.callId === entry.item.id)])
    .concat(prunes.filter(entry => !calls.has(pruneOf(entry.item.prune)?.callId ?? "")));
}
