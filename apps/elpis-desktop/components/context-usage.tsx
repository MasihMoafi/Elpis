"use client";

import { UNMEASURED, tokens, percent, levelOf, COMPACT_FROM_PERCENT, describe } from "./context-ledger";
export { UNMEASURED, tokens, share, describe } from "./context-ledger";
import { LedgerView } from "./context-ledger";
export { LedgerBar, LedgerRows, CacheRow } from "./context-ledger";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { ContextFiles, readContext } from "@/components/context-files";
import { api } from "@/lib/api";
import { usePreferences } from "@/lib/preferences";
import { errorText } from "@/lib/error-text.mts";

/** The bridge's Context Ledger for a chat (bridge/elpis-features.mjs `contextLedger`): `used` and `window` are
 * measured, `categories` are estimated shares that sum to `used`; empty when attribution is unavailable. `basis` says whose
 * estimate they are: the engine's for its latest request, or the bridge's from the chat's saved transcript. */
export type Ledger = {
  used: number | null;
  window: number | null;
  categories: { id: string; label: string; tokens: number }[];
  basis?: "engine" | "transcript";
};
/** The prompt cache's share of a prompt (bridge/elpis-features.mjs `cacheUse`): disjoint parts of `prompt`. */
export type CacheShare = { prompt: number; cacheRead: number; cacheWrite: number; uncached: number; hitPercent: number };
export type CacheUse = { last: CacheShare | null; total: CacheShare | null };
/** Whether the chat can be compacted now (bridge/client.mjs `context`), and why not. */
export type Compact = { available: boolean; reason?: string };
/** GET/POST /api/context/switches: the keys the TUI ledger's switches write (bridge/elpis-features.mjs). RAG is null
 * when no `rag` MCP server is configured. */
type Switches = {
  version: string | null;
  write: { available: boolean; reason?: string };
  smartPrune: boolean;
  subagents: boolean;
  rag: boolean | null;
};
// An older or unexpected bridge answer hides the switches instead of breaking the view.
const switchesOf = (value: unknown): Switches | null => {
  const read = value as Partial<Switches> | null;
  return read &&
    typeof read.smartPrune === "boolean" &&
    typeof read.subagents === "boolean" &&
    typeof read.write?.available === "boolean" &&
    (read.rag === null || typeof read.rag === "boolean")
    ? (read as Switches)
    : null;
};

/** /context dispatches this; it opens the breakdown for the current chat. */
export const OPEN_CONTEXT_EVENT = "elpis:open-context";
/** The Ledger button under the message box dispatches this; it opens the breakdown, or closes it when it is open. */
export const TOGGLE_CONTEXT_EVENT = "elpis:toggle-context";
/** Marks that button: pressing it is its own toggle, not a click outside the open breakdown. */
export const CONTEXT_TOGGLE_ATTRIBUTE = "data-context-toggle";

/** The right-hand Context tab shares the Ledger's file rows and their editor actions. */
export function ContextPanel({ threadId }: { threadId?: string }) {
  return (
    <div className="context-panel">
      {threadId ? (
        <ContextFiles key={threadId} threadId={threadId} session onOpenFile={() => {}} />
      ) : (
        <p className="context-ledger-note">Open a chat to see its goal and context.</p>
      )}
    </div>
  );
}

/** A thin context ring that fills clockwise in the chat accent. */
export function ContextRingIcon({ pct, size = 16 }: { pct: number; size?: number }) {
  const radius = (size - 2) / 2,
    circumference = 2 * Math.PI * radius,
    middle = size / 2;
  return (
    <svg
      className="context-ring-icon"
      data-level={levelOf(pct)}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
    >
      <circle cx={middle} cy={middle} r={radius} className="context-ring-track" />
      {pct > 0 && (
        <circle
          cx={middle}
          cy={middle}
          r={radius}
          className="context-ring-fill"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
          transform={`rotate(-90 ${middle} ${middle})`}
        />
      )}
    </svg>
  );
}

/** The chat's context ring, as Claude's composer has it: hovering shows "Context 73.8k / 475k (16%)", a click or Enter opens
 * the breakdown above it and a second one closes it, as does Escape or a click elsewhere. /context opens it even when the
 * ring is off (Settings → General → Show context window usage). */
export function ContextUsage({ threadId }: { threadId?: string }) {
  const { showContextUsage } = usePreferences();
  const triggerId = useId();
  const ringRef = useRef<HTMLButtonElement>(null);
  const [read, setRead] = useState<{
    threadId: string;
    ledger: Ledger;
    compact: Compact | null;
    cache?: CacheUse | null;
    unavailable?: boolean;
  } | null>(null);
  const [opened, setOpened] = useState(false);
  const [filesReady, setFilesReady] = useState(false),
    [revealed, setRevealed] = useState(false);
  const markFilesReady = useCallback(() => setFilesReady(true), []);
  const [openedFor, setOpenedFor] = useState(threadId);
  if (openedFor !== threadId) {
    setOpenedFor(threadId);
    setOpened(false);
  }
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    const open = () => setOpened(true),
      toggle = () => setOpened(current => !current);
    window.addEventListener(OPEN_CONTEXT_EVENT, open);
    window.addEventListener(TOGGLE_CONTEXT_EVENT, toggle);
    return () => {
      window.removeEventListener(OPEN_CONTEXT_EVENT, open);
      window.removeEventListener(TOGGLE_CONTEXT_EVENT, toggle);
    };
  }, []);
  const watching = Boolean(threadId) && (showContextUsage || opened);
  useEffect(() => {
    if (!threadId || !watching) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      if (document.visibilityState === "visible")
        try {
          const value = await readContext<{
            threadId: string;
            ledger?: Ledger;
            compact?: Compact;
            cache?: CacheUse | null;
          }>(`/threads/${encodeURIComponent(threadId)}/context`, controller.signal);
          if (value.threadId !== threadId) throw new Error("Context reply belongs to another chat.");
          if (!disposed && value.threadId === threadId) {
            setRead({
              threadId,
              ledger: value.ledger ?? UNMEASURED,
              compact: value.compact ?? null,
              cache: value.cache ?? null,
            });
          }
        } catch {
          if (!disposed) {
            setRead({ threadId, ledger: UNMEASURED, compact: null, unavailable: true });
          }
        }
      if (!disposed)
        timer = setTimeout(() => {
          void poll();
        }, 5000);
    };
    void poll();
    return () => {
      disposed = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [threadId, watching]);
  const current = threadId && read?.threadId === threadId ? read : null,
    ledger = current?.ledger ?? null;
  const contentReady = !threadId || (filesReady && current !== null);
  useEffect(() => {
    setRevealed(false);
    if (!opened) {
      setFilesReady(false);
      return;
    }
    if (!contentReady) return;
    // Let the hidden card's final content resize and its positioner settle before its first painted frame.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setRevealed(true));
    });
    return () => cancelAnimationFrame(frame);
  }, [opened, contentReady]);
  // In view on a new chat too: its ring is empty until the first message.
  if (!showContextUsage && !opened) return null;
  const { used, capacity, pct, tooltip } = describe(ledger);
  const name =
    used === null
      ? "Context window: not measured yet"
      : capacity
        ? `Context window: ${percent(used, capacity)}% used`
        : `Context window: ${tokens(used)} used`;
  const onOpenChange = (next: boolean, details: { reason: string; cancel: () => void; event?: Event }) => {
    // The Ledger button toggles it itself; counting its press as a click outside would close it just before that click reopens it.
    if (
      !next &&
      details.reason === "outside-press" &&
      (details.event?.target as Element | null)?.closest?.(`[${CONTEXT_TOGGLE_ATTRIBUTE}]`)
    ) {
      details.cancel();
      return;
    }
    setOpened(next);
  };
  const compact = async () => {
    if (!threadId) return;
    setOpened(false);
    try {
      await api(`/threads/${encodeURIComponent(threadId)}/compact`, {});
    } catch {
      /* the chat reports a refusal in its own error line */
    }
  };
  // Above the message box, level with the ring's right edge: the offset reaches from the ring to the composer's top.
  // Narrow composers hide the ring; anchoring to its zero rectangle makes collision sizing oscillate.
  const anchor = () => ({
    contextElement: ringRef.current?.closest(".composer") ?? undefined,
    getBoundingClientRect: () => {
      const ring = ringRef.current;
      return (
        (ring?.getClientRects().length ? ring : ring?.closest(".composer"))?.getBoundingClientRect() ?? new DOMRect()
      );
    },
  });
  const aboveComposer = ({ side }: { side: string }) => {
    const ring = ringRef.current,
      composer = ring?.closest(".composer");
    return side === "top" && ring?.getClientRects().length && composer
      ? ring.getBoundingClientRect().top - composer.getBoundingClientRect().top + 8
      : 8;
  };
  return (
    <Popover open={opened} onOpenChange={onOpenChange} triggerId={triggerId}>
      <Tooltip content={tooltip} suppressed={opened}>
        <PopoverTrigger
          ref={ringRef}
          id={triggerId}
          className="context-ring"
          aria-label={opened && !revealed ? "Loading context window…" : name}
          aria-busy={opened && !revealed}
          title={opened && !revealed ? "Loading context window…" : undefined}
        >
          {opened && !revealed ? <span aria-hidden="true">…</span> : <ContextRingIcon pct={pct} />}
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent
        anchor={anchor}
        side="top"
        align="end"
        sideOffset={aboveComposer}
        initialFocus={false}
        finalFocus={false}
        aria-label="Context window usage"
        className="context-ledger"
        style={{ visibility: revealed ? undefined : "hidden" }}
      >
        <LedgerView
          ledger={ledger}
          cache={current?.cache ?? null}
          loading={Boolean(threadId) && !ledger}
          unavailable={current?.unavailable}
          expanded={expanded}
          onToggle={() => setExpanded(value => !value)}
          compact={
            ledger && used !== null && capacity && pct >= COMPACT_FROM_PERCENT && current?.compact
              ? {
                  ...current.compact,
                  run: () => {
                    void compact();
                  },
                }
              : null
          }
        />
        {opened && threadId && (
          <ContextFiles
            key={threadId}
            threadId={threadId}
            onOpenFile={() => setOpened(false)}
            onReady={markFilesReady}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

type SwitchField = "smartPrune" | "subagents" | "rag";
/** One copy of the switches for every view of them (the ledger and the features under the message box), so a flip in
 * one shows in the other. Each view refreshes it when it appears, so a change made in the TUI shows too. */
let switchesNow: { state: Switches | null; saving: SwitchField | null; error: string } = {
  state: null,
  saving: null,
  error: "",
};
const switchListeners = new Set<() => void>();
const publishSwitches = (next: Partial<typeof switchesNow>) => {
  switchesNow = { ...switchesNow, ...next };
  for (const listener of switchListeners) listener();
};
export const reason = (value: unknown) => errorText(value);
const refreshSwitches = () =>
  api<unknown>("/context/switches").then(
    value => publishSwitches({ state: switchesOf(value), error: "" }),
    value => publishSwitches({ error: reason(value) }),
  );
async function saveSwitch(field: SwitchField, value: boolean) {
  const { state } = switchesNow;
  if (!state || switchesNow.saving) return;
  publishSwitches({ saving: field, error: "" });
  try {
    publishSwitches({
      state: switchesOf(await api<unknown>("/context/switches", { version: state.version, [field]: value })),
    });
  } catch (value) {
    publishSwitches({ error: reason(value) });
    void refreshSwitches();
  } finally {
    publishSwitches({ saving: null });
  }
}
/** The Smart Prune, Subagents and RAG switches (config keys: every chat, from its next turn) and a way to flip each. */
export function useContextSwitches() {
  const now = useSyncExternalStore(
    listener => {
      switchListeners.add(listener);
      return () => {
        switchListeners.delete(listener);
      };
    },
    () => switchesNow,
    () => switchesNow,
  );
  useEffect(() => {
    void refreshSwitches();
  }, []);
  return { ...now, save: saveSwitch };
}

/** The three switches as both the ledger and the features under the message box show them. */
export function switchRows(state: Switches) {
  return [
    {
      field: "smartPrune",
      label: "Smart Prune",
      on: state.smartPrune,
      detail: state.smartPrune
        ? "Before first main-model send · sent history stays stable"
        : "Tool results pass through unchanged",
      saving: "Saving setting · the active turn keeps its current policy",
    },
    {
      field: "subagents",
      label: "Subagents",
      on: state.subagents,
      detail: state.subagents ? "May delegate to other agents" : "All work stays in this thread",
      saving: "Saving… · applies next turn",
    },
    {
      field: "rag",
      label: "RAG",
      on: state.rag === true,
      detail:
        state.rag === null
          ? "No rag MCP server is configured"
          : state.rag
            ? "The rag MCP server's tools are available"
            : "The rag MCP server is off",
      saving: "Saving… · applies next turn",
    },
  ] as const;
}
/** A switch can't be flipped while another is saving, when the config can't be written, or for RAG without its server. */
export const switchLocked = (state: Switches, saving: SwitchField | null, field: SwitchField) =>
  !state.write.available || saving !== null || (field === "rag" && state.rag === null);
