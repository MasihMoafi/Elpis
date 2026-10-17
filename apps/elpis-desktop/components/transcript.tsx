"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { Entry, Item } from "@/lib/api";
import { elapsed, stepLabel, summarize, summaryParts } from "@/lib/steps";
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
  return <>{turns.map(turn => <Turn key={turn.id} turn={turn} active={turn.id === activeTurnId} onViewChanges={onViewChanges} {...draw} />)}
    {activeTurnId && !turns.some(turn => turn.id === activeTurnId) && <div className="turn-working" role="status"><LiveStep key={activeTurnId} label="Working" /></div>}
  </>;
}

type TurnEntries = { id: string; entries: Entry[] };
/** Elpis's answer: its message, or the review that /review ends with. */
const isReply = (item: Item) => item.type === "agentMessage" || item.type === "exitedReviewMode";

function turnsOf(entries: Entry[]): TurnEntries[] {
  const turns: TurnEntries[] = [];
  for (const entry of entries) {
    const last = turns.at(-1);
    if (last && last.id === entry.turnId) last.entries.push(entry);
    else turns.push({ id: entry.turnId, entries: [entry] });
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
  const users = turn.entries.filter(entry => entry.item.type === "userMessage");
  const work = turn.entries.filter(entry => entry.item.type !== "userMessage");
  // A proposed plan is the turn's answer as much as its last reply, so neither folds away.
  const lastReply = findLastIndex(work, entry => isReply(entry.item)), plan = work.findIndex(entry => entry.item.type === "plan");
  const finalReply = active ? -1 : plan >= 0 && (lastReply < 0 || plan < lastReply) ? plan : lastReply;
  const folded = finalReply > 0 ? work.slice(0, finalReply) : [];
  const visible = finalReply > 0 ? work.slice(finalReply) : work;
  return <section className="turn" aria-label="Turn" data-prompt={users.length > 0 ? "" : undefined}>
    {users.map(renderItem)}
    {folded.length > 0 && <details className="worked-for">
      <summary><span>{workedFor(turn.entries)}</span></summary>
      <div className="worked-for-body"><Flow entries={folded} renderItem={renderItem} mediaOf={mediaOf} /></div>
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
    if (isReply(entry.item) || entry.item.type === "plan" || (entry.item.type === "commandExecution" && entry.item.source === "userShell")) {
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
  const items = entries.map(entry => entry.item);
  const running = live ? entries.find(entry => entry.item.status === "inProgress") : undefined;
  const views = entries.filter(entry => entry.item.type === "imageView" && typeof entry.item.path === "string" && mediaOf?.(entry)).slice(0, 3);
  const edits = running ? null : turnEdits(items);
  return <details className="activity-group" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-expanded={open}>
      {running
        ? <LiveStep key={running.item.id} label={stepLabel(running.item, true)} since={running.startedAtMs} />
        : <span className="activity-group-label">{summaryParts(items).map((part, index) => <Fragment key={index}>{index > 0 && ", "}{part.text}{part.failed > 0 && <> <span className="activity-group-failed">({part.failed} failed)</span></>}</Fragment>)}</span>}
      {edits && edits.added + edits.removed > 0 && <Counts added={edits.added} removed={edits.removed} />}
      {views.map(entry => <ImageThumb key={entry.item.id} src={`${mediaOf!(entry)}/0`} name={fileKind(String(entry.item.path)).name} />)}
    </summary>
    <div className="activity-group-body">{entries.map(entry => <div key={entry.item.id}>{renderItem(entry)}</div>)}</div>
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
    <span className="live-dots" aria-hidden="true"><i /><i /><i /></span>
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
