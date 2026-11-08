"use client";

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

import type { Ledger, CacheShare, CacheUse, Compact } from "./context-usage";

/** The Ledger's bar on a full-window scale, one coloured segment per category (`data-category` carries the TUI's colours). */
export function LedgerBar({ ledger }: { ledger: Ledger | null }) {
  const { used, window: capacity, categories } = ledger ?? UNMEASURED;
  const scale = used !== null && capacity ? Math.max(capacity, used) : 0;
  if (used === null || !scale) return null;
  return (
    <div className="context-bar" aria-hidden="true">
      {categories.length ? (
        categories.map(row => (
          <span
            key={row.id}
            className="context-bar-segment"
            data-category={row.id}
            title={`${row.label}: ≈${tokens(row.tokens)}${capacity ? `, ${share(row.tokens, capacity)}` : ""}`}
            style={{ width: `${(row.tokens / scale) * 100}%` }}
          />
        ))
      ) : (
        <span className="context-bar-segment" style={{ width: `${(used / scale) * 100}%` }} />
      )}
    </div>
  );
}

/** The Ledger's category rows (label, estimated tokens, share of the window) and the free capacity. */
export function LedgerRows({ ledger }: { ledger: Ledger | null }) {
  const { used, window: capacity, categories } = ledger ?? UNMEASURED;
  return (
    <ul className="context-ledger-rows">
      {categories.map(row => (
        <li key={row.id} className="context-ledger-row" data-category={row.id}>
          <span className="context-ledger-row-label">{row.label}</span>
          <span className="context-ledger-row-value">≈{tokens(row.tokens)}</span>
          <span className="context-ledger-row-share">{capacity ? share(row.tokens, capacity) : ""}</span>
        </li>
      ))}
      {capacity && used !== null && (
        <li className="context-ledger-row" data-category="free">
          <span className="context-ledger-row-label">Free capacity</span>
          <span className="context-ledger-row-value">{tokens(Math.max(0, capacity - used))}</span>
          <span className="context-ledger-row-share">{share(Math.max(0, capacity - used), capacity)}</span>
        </li>
      )}
    </ul>
  );
}

/** Claude's context section (its popover's "Context window" block) over the TUI ledger's CONTEXT WINDOW section
 * (codex-rs/tui/src/chatwidget/context_ledger.rs): the measured total, the bar on a full-window scale, and the categories
 * below it. The title and the switches the TUI's ledger also has are in the chat below this popover, so they are not repeated. */
export function LedgerView({
  ledger,
  cache,
  loading,
  unavailable,
  expanded,
  onToggle,
  compact,
}: {
  ledger: Ledger | null;
  cache: CacheUse | null;
  loading: boolean;
  unavailable?: boolean | undefined;
  expanded: boolean;
  onToggle: () => void;
  compact: (Compact & { run: () => void }) | null;
}) {
  const { used, window: capacity, categories, basis } = ledger ?? UNMEASURED;
  const { summary } = describe(ledger);
  const note =
    used === null
      ? null
      : !categories.length
        ? "Core measured total; category attribution unavailable until the next provider attempt"
        : basis === "transcript"
          ? `Measured total · category ${capacity ? "shares" : "tokens"} estimated from the saved chat; exact after the next request`
          : `Measured total · estimated category ${capacity ? "shares" : "tokens"}`;
  const measured = used !== null;
  return (
    <>
      <button
        data-slot="ledger-head"
        type="button"
        className="context-ledger-head"
        aria-expanded={categories.length ? expanded : undefined}
        disabled={!categories.length}
        onClick={onToggle}
      >
        <span>Context window</span>
        {summary && <span className="context-ledger-summary">{summary}</span>}
        {categories.length > 0 && (
          <ChevronRight
            size={12}
            aria-hidden="true"
            className="context-ledger-caret"
            data-expanded={expanded || undefined}
          />
        )}
      </button>
      {measured && <LedgerBar ledger={ledger} />}
      {!measured && !loading && (
        <p className="context-ledger-note" role={unavailable ? "status" : undefined}>
          {unavailable ? "Context usage unavailable. Retrying…" : "Send a message to see context usage."}
        </p>
      )}
      {note && <p className="context-ledger-note">{note}</p>}
      {categories.length > 0 && expanded && <LedgerRows ledger={ledger} />}
      {cache && <CacheRow cache={cache} />}
      {compact && (
        <div className="context-ledger-compact">
          <span title={compact.available ? undefined : compact.reason}>
            <Button type="button" size="sm" variant="secondary" disabled={!compact.available} onClick={compact.run}>
              Compact session
            </Button>
          </span>
        </div>
      )}
    </>
  );
}

/** The Ledger's Prompt cache button, as DeepSeek Harness's composer shows cache hits: the latest request's share, and on
 * click how its prompt divided and the whole chat's share. Reused input costs a fraction of new input. */
export function CacheRow({ cache }: { cache: CacheUse }) {
  const [open, setOpen] = useState(false);
  const headline = cache.last ?? cache.total;
  if (!headline) return null;
  const detail = (label: string, share: CacheShare) => (
    <li className="context-ledger-row" data-cache={label === "Last request" ? "last" : "chat"}>
      <span className="context-ledger-row-label">{label}</span>
      <span className="context-ledger-row-value">
        {tokens(share.cacheRead)} of {tokens(share.prompt)}
      </span>
      <span className="context-ledger-row-share">{share.hitPercent}%</span>
    </li>
  );
  return (
    <>
      <Button
        data-slot="ledger-cache"
        type="button"
        variant="ghost"
        className="context-ledger-head"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        title="Prompt tokens the provider served from its cache. Reused input is billed at a fraction of new input."
      >
        <span>Prompt cache</span>
        <span className="context-ledger-summary">
          {headline.hitPercent}% {cache.last ? "last request" : "this chat"}
        </span>
        <ChevronRight size={12} aria-hidden="true" className="context-ledger-caret" data-expanded={open || undefined} />
      </Button>
      {open && (
        <ul className="context-ledger-rows" aria-label="Prompt cache">
          {cache.last && detail("Last request", cache.last)}
          {cache.total && detail("This chat", cache.total)}
          {cache.last && (
            <li className="context-ledger-row" data-cache="split">
              <span className="context-ledger-row-label">Last request split</span>
              <span className="context-ledger-row-value">
                {tokens(cache.last.uncached)} new · {tokens(cache.last.cacheWrite)} written
              </span>
              <span className="context-ledger-row-share" />
            </li>
          )}
        </ul>
      )}
    </>
  );
}

export const UNMEASURED: Ledger = { used: null, window: null, categories: [] };

// Numbers as the TUI's /context prints them: 980, 26.5k, 1.2m; shares to a tenth; the headline to a whole percent.
export const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");

export const tokens = (value: number) =>
  value >= 1e6 ? `${trim(value / 1e6)}m` : value >= 1e3 ? `${trim(value / 1e3)}k` : String(value);

export const share = (part: number, whole: number) => {
  const tenths = Math.floor((part * 1000 + Math.floor(whole / 2)) / whole);
  return `${Math.floor(tenths / 10)}.${tenths % 10}%`;
};

export const percent = (part: number, whole: number) => Math.floor((part * 100 + Math.floor(whole / 2)) / whole);

/** Retain usage levels for state while the ring keeps the chat accent. */
export const levelOf = (pct: number) => (pct >= 90 ? "critical" : pct >= 75 ? "warning" : "normal");

/** Claude shows "Compact session" once the context is half full. */
export const COMPACT_FROM_PERCENT = 50;

/** The usage amount shared by the ring, its tooltip and context breakdown. */
export function describe(ledger: Ledger | null) {
  const used = ledger?.used ?? null,
    capacity = ledger?.window ?? null;
  const summary =
    used === null
      ? null
      : capacity
        ? `${tokens(used)} / ${tokens(capacity)} (${percent(used, capacity)}%)`
        : tokens(used);
  return {
    used,
    capacity,
    summary,
    pct: used !== null && capacity ? Math.min(100, (used / capacity) * 100) : 0,
    tooltip: summary === null ? "Context window" : `Context ${summary}`,
  };
}
