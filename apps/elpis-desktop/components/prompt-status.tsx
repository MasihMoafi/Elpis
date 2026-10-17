"use client";

import type { PromptStatus } from "@/lib/prompt-history";

/** What a screen reader hears, in Claude's words. */
export const promptStatusText = (status: PromptStatus) => status.kind === "history"
  ? `History ${status.index}/${status.total}`
  : `Search history: ${status.query}${status.matchIndex ? ` — match ${status.matchIndex} of ${status.total}` : ""}${status.failed ? " — no match" : ""}`;

/** The line above the message box while ↑/↓ step through earlier messages or Ctrl+R searches them, as in Claude: the place
 * in the history, or the search with a pulsing caret and, after a few seconds, the keys that work. */
export function PromptStatusLine({ status }: { status: PromptStatus }) {
  return <>
    <span role="status" className="sr-only">{promptStatusText(status)}</span>
    <div aria-hidden="true" className="flex min-h-5 min-w-0 items-center gap-2 pb-1 text-xs text-muted-foreground">
      {status.kind === "history" ? <span className="tabular-nums">History {status.index}/{status.total}</span> : <>
        <span className={status.failed ? "text-destructive" : undefined}>Search history:</span>
        <span className="min-w-0 truncate font-mono text-foreground">{status.query}<span className="motion-safe:animate-pulse">▎</span></span>
        <span className={`ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap transition-opacity duration-300 motion-reduce:transition-none ${status.showHints ? "opacity-100" : "opacity-0"}`}>
          <kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd>cycle<span>·</span><kbd className="kbd">esc</kbd>cancel
        </span>
      </>}
    </div>
  </>;
}
