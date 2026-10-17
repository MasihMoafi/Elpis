"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import "@/components/settings/settings.css";
import { SettingRow } from "@/components/settings/rows";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { usePreferences } from "@/lib/preferences";

/** The bridge's Context Ledger for a chat (bridge/elpis-features.mjs `contextLedger`): `used` and `window` are
 * measured, `categories` are estimated shares that sum to `used`; empty when attribution is unavailable. */
type Ledger = { used: number | null; window: number | null; categories: { id: string; label: string; tokens: number }[] };
const UNMEASURED: Ledger = { used: null, window: null, categories: [] };
/** The chat's Smart Prune counters (thread/smartPrune/updated), as far as this connection has heard them. */
type Prune = { examinedOutputs?: number; admittedOutputs?: number; approxSavedTokens?: number } | null;
/** GET/POST /api/context/switches: the keys the TUI ledger's switches write (bridge/elpis-features.mjs). RAG is null
 * when no `rag` MCP server is configured. */
type Switches = { version: string | null; write: { available: boolean; reason?: string }; smartPrune: boolean; subagents: boolean; rag: boolean | null };
// An older or unexpected bridge answer hides the switches instead of breaking the view.
const switchesOf = (value: unknown): Switches | null => {
  const read = value as Partial<Switches> | null;
  return read && typeof read.smartPrune === "boolean" && typeof read.subagents === "boolean" && typeof read.write?.available === "boolean" && (read.rag === null || typeof read.rag === "boolean") ? read as Switches : null;
};

/** /context dispatches this; it opens the breakdown, pinned, for the current chat. */
export const OPEN_CONTEXT_EVENT = "elpis:open-context";

// Numbers as the TUI's /context prints them: 980, 26.5k, 1.2m; shares to a tenth; the headline to a whole percent.
const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
const tokens = (value: number) => value >= 1e6 ? `${trim(value / 1e6)}m` : value >= 1e3 ? `${trim(value / 1e3)}k` : String(value);
const share = (part: number, whole: number) => { const tenths = Math.floor((part * 1000 + Math.floor(whole / 2)) / whole); return `${Math.floor(tenths / 10)}.${tenths % 10}%`; };
const percent = (part: number, whole: number) => Math.floor((part * 100 + Math.floor(whole / 2)) / whole);

/** The chat's context ring (Settings → General → Show context window usage). Hovering it shows the TUI's Context
 * Ledger breakdown; a click or Enter pins it open, Escape closes it, and /context opens it even when the ring is off. */
export function ContextUsage({ threadId }: { threadId?: string }) {
  const { showContextUsage } = usePreferences();
  const triggerId = useId();
  const ringRef = useRef<HTMLButtonElement>(null);
  const [read, setRead] = useState<{ threadId: string; ledger: Ledger; prune: Prune } | null>(null);
  const [opened, setOpened] = useState<"hover" | "pinned" | null>(null);
  const [openedFor, setOpenedFor] = useState(threadId);
  if (openedFor !== threadId) { setOpenedFor(threadId); setOpened(null); }
  useEffect(() => {
    const open = () => setOpened("pinned");
    window.addEventListener(OPEN_CONTEXT_EVENT, open);
    return () => window.removeEventListener(OPEN_CONTEXT_EVENT, open);
  }, []);
  const watching = Boolean(threadId) && (showContextUsage || opened !== null);
  useEffect(() => {
    if (!threadId || !watching) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState === "visible") try {
        const value = await api<{ threadId: string; ledger?: Ledger; smartPrune?: Prune }>(`/threads/${encodeURIComponent(threadId)}/context`);
        if (!disposed && value.threadId === threadId) setRead({ threadId, ledger: value.ledger ?? UNMEASURED, prune: value.smartPrune ?? null });
      } catch { if (!disposed) setRead({ threadId, ledger: UNMEASURED, prune: null }); }
      if (!disposed) timer = setTimeout(poll, 5000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, [threadId, watching]);
  // In view on a new chat too: its ring is empty until the first message, and its ledger already holds the switches.
  if (!showContextUsage && opened === null) return null;
  const current = threadId && read?.threadId === threadId ? read : null, ledger = current?.ledger ?? null;
  const used = ledger?.used ?? null, capacity = ledger?.window ?? null;
  const fill = used !== null && capacity ? Math.min(100, used / capacity * 100) : 0;
  const radius = 7, circumference = 2 * Math.PI * radius;
  const name = used === null ? "Context window: not measured yet" : capacity ? `Context window: ${percent(used, capacity)}% used` : `Context window: ${tokens(used)} used`;
  const onOpenChange = (next: boolean, details: { reason: string; cancel: () => void }) => {
    // A press pins the breakdown, or closes it once pinned; hover opens and closes only an unpinned one.
    if (details.reason === "trigger-press") { details.cancel(); setOpened(opened === "pinned" ? null : "pinned"); }
    else if (details.reason === "trigger-hover") { if (opened === "pinned") details.cancel(); else setOpened(next ? "hover" : null); }
    else if (!next) setOpened(null);
  };
  // Above the message box, level with the ring's right edge: the offset reaches from the ring to the composer's top.
  const aboveComposer = ({ side }: { side: string }) => {
    const ring = ringRef.current, composer = ring?.closest(".composer");
    return side === "top" && ring && composer ? ring.getBoundingClientRect().top - composer.getBoundingClientRect().top + 8 : 8;
  };
  return <Popover open={opened !== null} onOpenChange={onOpenChange} triggerId={triggerId}>
    <PopoverTrigger ref={ringRef} id={triggerId} openOnHover delay={120} closeDelay={80} className="context-ring" aria-label={name}>
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={radius} className="context-ring-track" />
        {fill > 0 && <circle cx="9" cy="9" r={radius} className="context-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - fill / 100)} transform="rotate(-90 9 9)" />}
      </svg>
    </PopoverTrigger>
    <PopoverContent side="top" align="end" sideOffset={aboveComposer} initialFocus={false} finalFocus={false} aria-label="Context window usage" className="context-ledger">
      <LedgerTitle ledger={ledger} started={Boolean(threadId)} />
      <LedgerSwitches prune={current?.prune ?? null} />
      <LedgerView ledger={ledger} loading={Boolean(threadId) && !ledger} started={Boolean(threadId)} />
    </PopoverContent>
  </Popover>;
}

/** The TUI ledger's CONTEXT WINDOW section (codex-rs/tui/src/chatwidget/context_ledger.rs), on a full-window scale. */
/** The TUI ledger's title row: CONTEXT LEDGER, then what the context holds now. */
function LedgerTitle({ ledger, started }: { ledger: Ledger | null; started: boolean }) {
  const used = ledger?.used ?? null;
  return <p className="context-ledger-title"><span className="context-ledger-name">Context ledger</span><span>{used === null ? (started ? "context not measured" : "new chat") : `≈${tokens(used)} tokens in context`}</span></p>;
}

function LedgerView({ ledger, loading, started }: { ledger: Ledger | null; loading: boolean; started: boolean }) {
  const { used, window: capacity, categories } = ledger ?? UNMEASURED;
  const total = used === null ? (loading ? "reading…" : started ? "usage unavailable" : "not measured yet") : capacity ? `${tokens(used)} of ${tokens(capacity)} used (${percent(used, capacity)}%)` : `${tokens(used)} used · capacity unknown`;
  const scale = used !== null && capacity ? Math.max(capacity, used) : 0;
  const note = used === null ? (loading ? null : started ? "Context measurement unavailable until the first request snapshot" : "Measured from this chat's first message")
    : !categories.length ? "Core measured total; category attribution unavailable until the next provider attempt"
    : `Measured total · estimated category ${capacity ? "shares" : "tokens"}`;
  return <>
    <p className="context-ledger-head"><span className="hud-menu-title">Context window</span><span>{total}</span></p>
    {scale > 0 && <div className="context-bar" aria-hidden="true">
      {categories.length ? categories.map(row => <span key={row.id} className="context-bar-segment" data-category={row.id} style={{ width: `${row.tokens / scale * 100}%` }} />)
        : <span className="context-bar-segment" style={{ width: `${used! / scale * 100}%` }} />}
    </div>}
    {note && <p className="context-ledger-note">{note}</p>}
    {categories.length > 0 && <ul className="context-ledger-rows">
      {categories.map(row => <li key={row.id} className="context-ledger-row" data-category={row.id}>
        <span className="context-ledger-row-label">{row.label}</span><span className="context-ledger-row-value">≈{tokens(row.tokens)}{capacity ? ` · ${share(row.tokens, capacity)}` : ""}</span>
      </li>)}
      {capacity && used !== null && <li className="context-ledger-row" data-category="free">
        <span className="context-ledger-row-label">Free capacity</span><span className="context-ledger-row-value">{tokens(Math.max(0, capacity - used))} · {share(Math.max(0, capacity - used), capacity)}</span>
      </li>}
    </ul>}
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
export function switchRows(state: Switches, prune: Prune = null) {
  const examined = prune?.examinedOutputs ?? 0;
  return [
    { field: "smartPrune", label: "Smart Prune", on: state.smartPrune, detail: examined > 0 ? `${prune?.admittedOutputs ?? 0} of ${examined} eligible outputs shortened · ≈${tokens(prune?.approxSavedTokens ?? 0)} tokens saved`
      : state.smartPrune ? "Before first main-model send · sent history stays stable" : "Tool results pass through unchanged", saving: "Saving setting · the active turn keeps its current policy" },
    { field: "subagents", label: "Subagents", on: state.subagents, detail: state.subagents ? "May delegate to other agents" : "All work stays in this thread", saving: "Saving… · applies next turn" },
    { field: "rag", label: "RAG", on: state.rag === true, detail: state.rag === null ? "No rag MCP server is configured" : state.rag ? "The rag MCP server's tools are available" : "The rag MCP server is off", saving: "Saving… · applies next turn" },
  ] as const;
}
/** A switch can't be flipped while another is saving, when the config can't be written, or for RAG without its server. */
export const switchLocked = (state: Switches, saving: SwitchField | null, field: SwitchField) => !state.write.available || saving !== null || (field === "rag" && state.rag === null);

/** The TUI ledger's SMART PRUNE and SUBAGENTS switches, with its detail lines, and a RAG switch for the rag MCP server
 * (the TUI has /rag but no switch). All three are config keys, so they apply to every chat from its next turn. */
function LedgerSwitches({ prune }: { prune: Prune }) {
  const { state, saving, error, save } = useContextSwitches();
  if (!state) return error ? <p role="alert" className="context-ledger-note">{error}</p> : null;
  const rows = switchRows(state, prune);
  return <div className="context-ledger-switches">
    {rows.map(row => <SettingRow key={row.field} title={row.label} description={saving === row.field ? row.saving : row.detail}>
      <Switch size="sm" aria-label={row.label} checked={saving === row.field ? !row.on : row.on} disabled={switchLocked(state, saving, row.field)} onCheckedChange={checked => void save(row.field, checked)} />
    </SettingRow>)}
    <p className={error ? "context-ledger-note text-destructive" : "context-ledger-note"} role={error ? "alert" : undefined}>{error || (state.write.available ? "For every chat, from its next turn; a running turn is unchanged" : state.write.reason)}</p>
  </div>;
}
