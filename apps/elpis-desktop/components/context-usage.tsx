"use client";

import { ChevronRight } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip } from "@/components/ui/tooltip";
import { ContextFiles, readContext } from "@/components/context-files";
import { api } from "@/lib/api";
import { usePreferences } from "@/lib/preferences";

/** The bridge's Context Ledger for a chat (bridge/elpis-features.mjs `contextLedger`): `used` and `window` are
 * measured, `categories` are estimated shares that sum to `used`; empty when attribution is unavailable. `basis` says whose
 * estimate they are: the engine's for its latest request, or the bridge's from the chat's saved transcript. */
export type Ledger = { used: number | null; window: number | null; categories: { id: string; label: string; tokens: number }[]; basis?: "engine" | "transcript" };
const UNMEASURED: Ledger = { used: null, window: null, categories: [] };
/** Whether the chat can be compacted now (bridge/client.mjs `context`), and why not. */
type Compact = { available: boolean; reason?: string };
/** GET/POST /api/context/switches: the keys the TUI ledger's switches write (bridge/elpis-features.mjs). RAG is null
 * when no `rag` MCP server is configured. */
type Switches = { version: string | null; write: { available: boolean; reason?: string }; smartPrune: boolean; subagents: boolean; rag: boolean | null };
// An older or unexpected bridge answer hides the switches instead of breaking the view.
const switchesOf = (value: unknown): Switches | null => {
  const read = value as Partial<Switches> | null;
  return read && typeof read.smartPrune === "boolean" && typeof read.subagents === "boolean" && typeof read.write?.available === "boolean" && (read.rag === null || typeof read.rag === "boolean") ? read as Switches : null;
};

/** /context dispatches this; it opens the breakdown for the current chat. */
export const OPEN_CONTEXT_EVENT = "elpis:open-context";
/** The Ledger button under the message box dispatches this; it opens the breakdown, or closes it when it is open. */
export const TOGGLE_CONTEXT_EVENT = "elpis:toggle-context";
/** Marks that button: pressing it is its own toggle, not a click outside the open breakdown. */
export const CONTEXT_TOGGLE_ATTRIBUTE = "data-context-toggle";

// Numbers as the TUI's /context prints them: 980, 26.5k, 1.2m; shares to a tenth; the headline to a whole percent.
const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
const tokens = (value: number) => value >= 1e6 ? `${trim(value / 1e6)}m` : value >= 1e3 ? `${trim(value / 1e3)}k` : String(value);
const share = (part: number, whole: number) => { const tenths = Math.floor((part * 1000 + Math.floor(whole / 2)) / whole); return `${Math.floor(tenths / 10)}.${tenths % 10}%`; };
const percent = (part: number, whole: number) => Math.floor((part * 100 + Math.floor(whole / 2)) / whole);
/** Claude's ring turns amber from 75% and red from 90%. */
const levelOf = (pct: number) => pct >= 90 ? "critical" : pct >= 75 ? "warning" : "normal";
/** Claude shows "Compact session" once the context is half full. */
const COMPACT_FROM_PERCENT = 50;

/** What the ring, its tooltip and the Ledger button say about a ledger: Claude's "Context 73.8k / 475k (16%)". */
function describe(ledger: Ledger | null) {
  const used = ledger?.used ?? null, capacity = ledger?.window ?? null;
  const summary = used === null ? null : capacity ? `${tokens(used)} / ${tokens(capacity)} (${percent(used, capacity)}%)` : tokens(used);
  return { used, capacity, summary, pct: used !== null && capacity ? Math.min(100, used / capacity * 100) : 0, tooltip: summary === null ? "Context window" : `Context ${summary}` };
}

/** Claude's context ring: a thin ring that fills clockwise, amber from 75% and red from 90%. */
export function ContextRingIcon({ pct, size = 16 }: { pct: number; size?: number }) {
  const radius = (size - 2) / 2, circumference = 2 * Math.PI * radius, middle = size / 2;
  return <svg className="context-ring-icon" data-level={levelOf(pct)} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
    <circle cx={middle} cy={middle} r={radius} className="context-ring-track" />
    {pct > 0 && <circle cx={middle} cy={middle} r={radius} className="context-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - pct / 100)} transform={`rotate(-90 ${middle} ${middle})`} />}
  </svg>;
}

/** The ledger the ring last read, for the Ledger button under the message box to draw the same ring and say the same numbers. */
let sharedNow: { threadId?: string; ledger: Ledger | null } = { ledger: null };
const sharedListeners = new Set<() => void>();
const publishShared = (next: typeof sharedNow) => { sharedNow = next; for (const listener of sharedListeners) listener(); };
export function useSharedLedger(threadId?: string) {
  const now = useSyncExternalStore(listener => { sharedListeners.add(listener); return () => { sharedListeners.delete(listener); }; }, () => sharedNow, () => sharedNow);
  return describe(threadId && now.threadId === threadId ? now.ledger : null);
}

/** The chat's context ring, as Claude's composer has it: hovering shows "Context 73.8k / 475k (16%)", a click or Enter opens
 * the breakdown above it and a second one closes it, as does Escape or a click elsewhere. /context opens it even when the
 * ring is off (Settings → General → Show context window usage). */
export function ContextUsage({ threadId }: { threadId?: string }) {
  const { showContextUsage } = usePreferences();
  const triggerId = useId();
  const ringRef = useRef<HTMLButtonElement>(null);
  const [read, setRead] = useState<{ threadId: string; ledger: Ledger; compact: Compact | null; unavailable?: boolean } | null>(null);
  const [opened, setOpened] = useState(false);
  const [filesReady, setFilesReady] = useState(false), [revealed, setRevealed] = useState(false);
  const markFilesReady = useCallback(() => setFilesReady(true), []);
  const [openedFor, setOpenedFor] = useState(threadId);
  if (openedFor !== threadId) { setOpenedFor(threadId); setOpened(false); }
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    const open = () => setOpened(true), toggle = () => setOpened(current => !current);
    window.addEventListener(OPEN_CONTEXT_EVENT, open); window.addEventListener(TOGGLE_CONTEXT_EVENT, toggle);
    return () => { window.removeEventListener(OPEN_CONTEXT_EVENT, open); window.removeEventListener(TOGGLE_CONTEXT_EVENT, toggle); };
  }, []);
  const watching = Boolean(threadId) && (showContextUsage || opened);
  useEffect(() => {
    if (!threadId || !watching) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const poll = async () => {
      if (document.visibilityState === "visible") try {
        const value = await readContext<{ threadId: string; ledger?: Ledger; compact?: Compact }>(`/threads/${encodeURIComponent(threadId)}/context`, controller.signal);
        if (value.threadId !== threadId) throw new Error("Context reply belongs to another chat.");
        if (!disposed && value.threadId === threadId) { setRead({ threadId, ledger: value.ledger ?? UNMEASURED, compact: value.compact ?? null }); publishShared({ threadId, ledger: value.ledger ?? UNMEASURED }); }
      } catch { if (!disposed) { setRead({ threadId, ledger: UNMEASURED, compact: null, unavailable: true }); publishShared({ threadId, ledger: UNMEASURED }); } }
      if (!disposed) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { disposed = true; controller.abort(); clearTimeout(timer); };
  }, [threadId, watching]);
  const current = threadId && read?.threadId === threadId ? read : null, ledger = current?.ledger ?? null;
  const contentReady = !threadId || (filesReady && current !== null);
  useEffect(() => {
    setRevealed(false);
    if (!opened) { setFilesReady(false); return; }
    if (!contentReady) return;
    // Let the hidden card's final content resize and its positioner settle before its first painted frame.
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => setRevealed(true)); });
    return () => cancelAnimationFrame(frame);
  }, [opened, contentReady]);
  // In view on a new chat too: its ring is empty until the first message.
  if (!showContextUsage && !opened) return null;
  const { used, capacity, pct, tooltip } = describe(ledger);
  const name = used === null ? "Context window: not measured yet" : capacity ? `Context window: ${percent(used, capacity)}% used` : `Context window: ${tokens(used)} used`;
  const onOpenChange = (next: boolean, details: { reason: string; cancel: () => void; event?: Event }) => {
    // The Ledger button toggles it itself; counting its press as a click outside would close it just before that click reopens it.
    if (!next && details.reason === "outside-press" && (details.event?.target as Element | null)?.closest?.(`[${CONTEXT_TOGGLE_ATTRIBUTE}]`)) { details.cancel(); return; }
    setOpened(next);
  };
  const compact = async () => {
    if (!threadId) return;
    setOpened(false);
    try { await api(`/threads/${encodeURIComponent(threadId)}/compact`, {}); } catch { /* the chat reports a refusal in its own error line */ }
  };
  // Above the message box, level with the ring's right edge: the offset reaches from the ring to the composer's top.
  // Narrow composers hide the ring; anchoring to its zero rectangle makes collision sizing oscillate.
  const anchor = () => ({
    contextElement: ringRef.current?.closest(".composer") ?? undefined,
    getBoundingClientRect: () => {
      const ring = ringRef.current;
      return (ring?.getClientRects().length ? ring : ring?.closest(".composer"))?.getBoundingClientRect() ?? new DOMRect();
    },
  });
  const aboveComposer = ({ side }: { side: string }) => {
    const ring = ringRef.current, composer = ring?.closest(".composer");
    return side === "top" && ring?.getClientRects().length && composer ? ring.getBoundingClientRect().top - composer.getBoundingClientRect().top + 8 : 8;
  };
  return <Popover open={opened} onOpenChange={onOpenChange} triggerId={triggerId}>
    <Tooltip content={tooltip} suppressed={opened}>
      <PopoverTrigger ref={ringRef} id={triggerId} className="context-ring" aria-label={opened && !revealed ? "Loading context window…" : name} aria-busy={opened && !revealed} title={opened && !revealed ? "Loading context window…" : undefined}>{opened && !revealed ? <span aria-hidden="true">…</span> : <ContextRingIcon pct={pct} />}</PopoverTrigger>
    </Tooltip>
    <PopoverContent anchor={anchor} side="top" align="end" sideOffset={aboveComposer} initialFocus={false} finalFocus={false} aria-label="Context window usage" className="context-ledger" style={{ visibility: revealed ? undefined : "hidden" }}>
      <LedgerView ledger={ledger} loading={Boolean(threadId) && !ledger} unavailable={current?.unavailable} expanded={expanded} onToggle={() => setExpanded(value => !value)}
        compact={ledger && used !== null && capacity && pct >= COMPACT_FROM_PERCENT && current?.compact ? { ...current.compact, run: compact } : null} />
      {opened && threadId && <ContextFiles key={threadId} threadId={threadId} onOpenFile={() => setOpened(false)} onReady={markFilesReady} />}
    </PopoverContent>
  </Popover>;
}

/** The Ledger's bar on a full-window scale, one coloured segment per category (`data-category` carries the TUI's colours). */
export function LedgerBar({ ledger }: { ledger: Ledger | null }) {
  const { used, window: capacity, categories } = ledger ?? UNMEASURED;
  const scale = used !== null && capacity ? Math.max(capacity, used) : 0;
  if (used === null || !scale) return null;
  return <div className="context-bar" aria-hidden="true">
    {categories.length ? categories.map(row => <span key={row.id} className="context-bar-segment" data-category={row.id} title={`${row.label}: ≈${tokens(row.tokens)}${capacity ? `, ${share(row.tokens, capacity)}` : ""}`} style={{ width: `${row.tokens / scale * 100}%` }} />)
      : <span className="context-bar-segment" style={{ width: `${used / scale * 100}%` }} />}
  </div>;
}

/** The Ledger's category rows (label, estimated tokens, share of the window) and the free capacity. */
export function LedgerRows({ ledger }: { ledger: Ledger | null }) {
  const { used, window: capacity, categories } = ledger ?? UNMEASURED;
  return <ul className="context-ledger-rows">
    {categories.map(row => <li key={row.id} className="context-ledger-row" data-category={row.id}>
      <span className="context-ledger-row-label">{row.label}</span><span className="context-ledger-row-value">≈{tokens(row.tokens)}</span><span className="context-ledger-row-share">{capacity ? share(row.tokens, capacity) : ""}</span>
    </li>)}
    {capacity && used !== null && <li className="context-ledger-row" data-category="free">
      <span className="context-ledger-row-label">Free capacity</span><span className="context-ledger-row-value">{tokens(Math.max(0, capacity - used))}</span><span className="context-ledger-row-share">{share(Math.max(0, capacity - used), capacity)}</span>
    </li>}
  </ul>;
}

/** Claude's context section (its popover's "Context window" block) over the TUI ledger's CONTEXT WINDOW section
 * (codex-rs/tui/src/chatwidget/context_ledger.rs): the measured total, the bar on a full-window scale, and the categories
 * below it. The title and the switches the TUI's ledger also has are in the chat below this popover, so they are not repeated. */
function LedgerView({ ledger, loading, unavailable, expanded, onToggle, compact }: { ledger: Ledger | null; loading: boolean; unavailable?: boolean; expanded: boolean; onToggle: () => void; compact: (Compact & { run: () => void }) | null }) {
  const { used, window: capacity, categories, basis } = ledger ?? UNMEASURED;
  const { summary } = describe(ledger);
  const note = used === null ? null
    : !categories.length ? "Core measured total; category attribution unavailable until the next provider attempt"
    : basis === "transcript" ? `Measured total · category ${capacity ? "shares" : "tokens"} estimated from the saved chat; exact after the next request`
    : `Measured total · estimated category ${capacity ? "shares" : "tokens"}`;
  const measured = used !== null;
  return <>
    <button data-slot="ledger-head" type="button" className="context-ledger-head" aria-expanded={categories.length ? expanded : undefined} disabled={!categories.length} onClick={onToggle}>
      <span>Context window</span>{summary && <span className="context-ledger-summary">{summary}</span>}
      {categories.length > 0 && <ChevronRight size={12} aria-hidden="true" className="context-ledger-caret" data-expanded={expanded || undefined} />}
    </button>
    {measured && <LedgerBar ledger={ledger} />}
    {!measured && !loading && <p className="context-ledger-note" role={unavailable ? "status" : undefined}>{unavailable ? "Context usage unavailable. Retrying…" : "Send a message to see context usage."}</p>}
    {note && <p className="context-ledger-note">{note}</p>}
    {categories.length > 0 && expanded && <LedgerRows ledger={ledger} />}
    {compact && <div className="context-ledger-compact">
      <span title={compact.available ? undefined : compact.reason}><Button type="button" size="sm" variant="secondary" disabled={!compact.available} onClick={compact.run}>Compact session</Button></span>
    </div>}
  </>;
}

type SwitchField = "smartPrune" | "subagents" | "rag";
/** One copy of the switches for every view of them (the ledger and the features under the message box), so a flip in
 * one shows in the other. Each view refreshes it when it appears, so a change made in the TUI shows too. */
let switchesNow: { state: Switches | null; saving: SwitchField | null; error: string } = { state: null, saving: null, error: "" };
const switchListeners = new Set<() => void>();
const publishSwitches = (next: Partial<typeof switchesNow>) => { switchesNow = { ...switchesNow, ...next }; for (const listener of switchListeners) listener(); };
const reason = (value: unknown) => value instanceof Error ? value.message : String(value);
const refreshSwitches = () => api<unknown>("/context/switches").then(value => publishSwitches({ state: switchesOf(value), error: "" }), value => publishSwitches({ error: reason(value) }));
async function saveSwitch(field: SwitchField, value: boolean) {
  const { state } = switchesNow; if (!state || switchesNow.saving) return;
  publishSwitches({ saving: field, error: "" });
  try { publishSwitches({ state: switchesOf(await api<unknown>("/context/switches", { version: state.version, [field]: value })) }); }
  catch (value) { publishSwitches({ error: reason(value) }); void refreshSwitches(); }
  finally { publishSwitches({ saving: null }); }
}
/** The Smart Prune, Subagents and RAG switches (config keys: every chat, from its next turn) and a way to flip each. */
export function useContextSwitches() {
  const now = useSyncExternalStore(listener => { switchListeners.add(listener); return () => { switchListeners.delete(listener); }; }, () => switchesNow, () => switchesNow);
  useEffect(() => { void refreshSwitches(); }, []);
  return { ...now, save: saveSwitch };
}

/** The three switches as both the ledger and the features under the message box show them. */
export function switchRows(state: Switches) {
  return [
    { field: "smartPrune", label: "Smart Prune", on: state.smartPrune, detail: state.smartPrune ? "Before first main-model send · sent history stays stable" : "Tool results pass through unchanged", saving: "Saving setting · the active turn keeps its current policy" },
    { field: "subagents", label: "Subagents", on: state.subagents, detail: state.subagents ? "May delegate to other agents" : "All work stays in this thread", saving: "Saving… · applies next turn" },
    { field: "rag", label: "RAG", on: state.rag === true, detail: state.rag === null ? "No rag MCP server is configured" : state.rag ? "The rag MCP server's tools are available" : "The rag MCP server is off", saving: "Saving… · applies next turn" },
  ] as const;
}
/** A switch can't be flipped while another is saving, when the config can't be written, or for RAG without its server. */
export const switchLocked = (state: Switches, saving: SwitchField | null, field: SwitchField) => !state.write.available || saving !== null || (field === "rag" && state.rag === null);
