"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { CollapseDetails } from "@/components/step";
import { WorkingMark } from "@/components/working-mark";
import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { Entry } from "@/lib/api";
import { elapsed, stepLabel, summaryParts } from "@/lib/steps";
import { ImageThumb, fileKind } from "@/components/file-cards";
import { Counts } from "@/components/diff-view";
import { turnEdits } from "@/lib/diff";

import type { Draw } from "./transcript";
import type { Item } from "@/lib/api";

/** Replies stay as they are; each run of tool activity between them becomes one line. */
/** `end` names the turn's final reply: only it keeps room under it for its hover actions (message-actions.css). */
export function Flow({
  entries,
  renderItem,
  mediaOf,
  wrapItem,
  live = false,
  end,
}: { entries: Entry[]; live?: boolean; end?: string | undefined } & Draw) {
  const blocks: ReactNode[] = [];
  let run: Entry[] = [];
  const flush = () => {
    if (run[0])
      blocks.push(
        <ActivityGroup
          key={`group-${run[0].item.id}`}
          entries={run}
          renderItem={renderItem}
          mediaOf={mediaOf}
          wrapItem={wrapItem}
          live={live}
        />,
      );
    run = [];
  };
  for (const entry of entries) {
    if (isCompaction(entry.item)) {
      flush();
      blocks.push(
        <div key={entry.item.id}>
          {renderItem({ ...entry, item: { id: entry.item.id, type: "contextCompaction" } })}
        </div>,
      );
    } else if (
      isReply(entry.item) ||
      entry.item.type === "userMessage" ||
      entry.item.type === "plan" ||
      (entry.item.type === "commandExecution" && entry.item.source === "userShell")
    ) {
      flush();
      blocks.push(
        <div key={entry.item.id} data-reply-end={entry.item.id === end || undefined}>
          {renderItem(entry)}
        </div>,
      );
    } else run.push(entry);
  }
  flush();
  return <>{blocks}</>;
}

/** A run of tool activity as one muted row: what is running now, with its timer, or once finished what was done
 * ("Ran 2 commands (1 failed)") and the lines it added and removed ("+3 −1"), with the images it viewed as thumbnails, as
 * Claude's rows have them. Collapsed until opened by click, Enter or Space. */
export function ActivityGroup({
  entries,
  renderItem,
  mediaOf,
  wrapItem,
  live,
}: { entries: Entry[]; live: boolean } & Draw) {
  const [open, setOpen] = useState(false);
  const items = entries.filter(entry => entry.item.type !== "smartPrune").map(entry => entry.item);
  const running = live ? entries.find(entry => entry.item.status === "inProgress") : undefined;
  const views = entries
    .filter(entry => entry.item.type === "imageView" && typeof entry.item.path === "string" && mediaOf?.(entry))
    .slice(0, 3);
  const edits = running ? null : turnEdits(items);
  return (
    <details
      className="activity-group"
      onToggle={event => {
        if (event.target === event.currentTarget) setOpen(event.currentTarget.open);
      }}
    >
      <DisclosureSummary aria-expanded={open}>
        {running ? (
          <LiveStep
            key={running.item.id}
            label={stepLabel(running.item, true)}
            since={running.startedAtMs}
            mark={false}
          />
        ) : (
          <span className="activity-group-label">
            {summaryParts(items).map((part, index) => (
              <Fragment key={index}>
                {index > 0 && ", "}
                {part.text}
                {part.failed > 0 && (
                  <>
                    {" "}
                    <span className="activity-group-failed">({part.failed} failed)</span>
                  </>
                )}
              </Fragment>
            ))}
          </span>
        )}
        {edits && edits.added + edits.removed > 0 && <Counts added={edits.added} removed={edits.removed} />}
        {views.map(entry => {
          const image = <ImageThumb src={`${mediaOf!(entry)}/0`} name={fileKind(String(entry.item.path)).name} />;
          return <Fragment key={entry.item.id}>{wrapItem ? wrapItem(entry, image) : image}</Fragment>;
        })}
      </DisclosureSummary>
      {open && (
        <div className="activity-group-body">
          {entries.map(entry => (
            <div key={entry.item.id}>{renderItem(entry)}</div>
          ))}
          <CollapseDetails label="Collapse tool calls" />
        </div>
      )}
    </details>
  );
}

/** The timer is not drawn for a step's first seconds, as in Claude's rows. */
export const TIMER_FROM_MS = 2000;

/** Something in progress, as a sentence with animated dots and a timer counting from `since` (else from now). */
export function LiveStep({ label, since, mark = true }: { label: string; since?: number | undefined; mark?: boolean }) {
  const [start] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      {mark && <WorkingMark />}
      <span className="live-label">{label}</span>
      {now - start >= TIMER_FROM_MS && (
        <>
          {" "}
          <span className="live-timer">{elapsed(now - start)}</span>
        </>
      )}
    </>
  );
}

/** Elpis's answer: its message, or the review that /review ends with. */
export const isReply = (item: Item) => item.type === "agentMessage" || item.type === "exitedReviewMode";

export const isCompaction = (item: Item) =>
  item.type === "contextCompaction" ||
  (item.type === "commandExecution" && item.command === "Compact conversation" && item.status === "completed");
