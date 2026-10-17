"use client";

import { ScrollText } from "lucide-react";
import { OPEN_CONTEXT_EVENT, switchLocked, switchRows, useContextSwitches } from "@/components/context-usage";

/** Elpis's own features under the message box, always in view, as the TUI's ledger sits beside its composer: the
 * chat's Context Ledger, and the Smart Prune, Subagents and RAG switches, one click each (olive when on). */
export function ElpisFeatures({ threadId }: { threadId?: string }) {
  const { state, saving, save } = useContextSwitches();
  if (!state && !threadId) return null;
  return <div role="group" aria-label="Elpis features" className="elpis-features">
    {threadId && <button type="button" className="feature-chip" title="Context Ledger: what this chat's context holds (/context)" onClick={() => window.dispatchEvent(new Event(OPEN_CONTEXT_EVENT))}><ScrollText size={14} aria-hidden="true" />Ledger</button>}
    {state && switchRows(state).map(row => {
      const on = saving === row.field ? !row.on : row.on;
      return <button key={row.field} type="button" className="feature-chip" aria-pressed={on} disabled={switchLocked(state, saving, row.field)} title={`${row.label}: ${saving === row.field ? row.saving : row.detail}`} onClick={() => void save(row.field, !row.on)}>
        <i className="feature-dot" aria-hidden="true" />{row.label}
      </button>;
    })}
  </div>;
}
