"use client";

import { switchLocked, switchRows, useContextSwitches } from "@/components/context-usage";

/** Elpis's own features under the message box, always in view, as the TUI's ledger sits beside its composer: the
 * Smart Prune, Subagents and RAG switches, one click each (the chat accent when on). */
export function ElpisFeatures() {
  const { state, saving, error, save } = useContextSwitches();
  if (!state) return null;
  return <div role="group" aria-label="Elpis features" className="elpis-features">

    {state && switchRows(state).map(row => {
      const on = saving === row.field ? !row.on : row.on;
      return <button data-slot="feature-chip" key={row.field} type="button" className="feature-chip" aria-pressed={on} disabled={switchLocked(state, saving, row.field)} title={`${row.label}: ${error || (!state.write.available && state.write.reason) || (saving === row.field ? row.saving : row.detail)}`} onClick={() => void save(row.field, !row.on)}>
        <i className="feature-dot" aria-hidden="true" />{row.label}
      </button>;
    })}
  </div>;
}
