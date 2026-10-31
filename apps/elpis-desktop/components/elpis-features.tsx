"use client";

import { CONTEXT_TOGGLE_ATTRIBUTE, ContextRingIcon, TOGGLE_CONTEXT_EVENT, switchLocked, switchRows, useContextSwitches, useSharedLedger } from "@/components/context-usage";
import { Tooltip } from "@/components/ui/tooltip";

/** Elpis's own features under the message box, always in view, as the TUI's ledger sits beside its composer: the
 * chat's Context Ledger, and the Smart Prune, Subagents and RAG switches, one click each (the chat accent when on). */
export function ElpisFeatures({ threadId }: { threadId?: string }) {
  const { state, saving, error, save } = useContextSwitches();
  const ledger = useSharedLedger(threadId);
  if (!state && !threadId) return null;
  return <div role="group" aria-label="Elpis features" className="elpis-features">
    {threadId && <Tooltip content={ledger.tooltip} detail="Open what this chat's context holds (/context)">
      <button data-slot="feature-chip" type="button" className="feature-chip" {...{ [CONTEXT_TOGGLE_ATTRIBUTE]: "" }} onClick={() => window.dispatchEvent(new Event(TOGGLE_CONTEXT_EVENT))}><ContextRingIcon pct={ledger.pct} size={7} />Ledger</button>
    </Tooltip>}
    {state && switchRows(state).map(row => {
      const on = saving === row.field ? !row.on : row.on;
      return <button data-slot="feature-chip" key={row.field} type="button" className="feature-chip" aria-pressed={on} disabled={switchLocked(state, saving, row.field)} title={`${row.label}: ${error || (!state.write.available && state.write.reason) || (saving === row.field ? row.saving : row.detail)}`} onClick={() => void save(row.field, !row.on)}>
        <i className="feature-dot" aria-hidden="true" />{row.label}
      </button>;
    })}
  </div>;
}
