"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AppUpdateState } from "@/lib/desktop";

/** Every desktop title bar uses the same installed-update control. */
export function AppUpdate({ showCurrent = false }: { showCurrent?: boolean }) {
  const [state, setState] = useState<AppUpdateState | null>(null);
  useEffect(() => {
    const updates = window.elpisDesktop?.updates;
    if (!updates) return;
    let disposed = false;
    const receive = (value: AppUpdateState) => { if (!disposed) setState(value); };
    const stop = updates.subscribe(receive);
    void updates.status().then(receive).catch(error => receive({ available: false, desktop: false, engine: false, restarting: false, error: error instanceof Error ? error.message : String(error) }));
    return () => { disposed = true; stop(); };
  }, []);
  if (!state?.available) return showCurrent ? <span role={state?.error ? "alert" : "status"} className={state?.error ? "text-destructive" : "text-muted-foreground"}>{state?.error ?? (state ? "No update ready." : "Update status is available in the desktop app.")}</span> : null;
  const restart = async () => {
    try { await window.elpisDesktop?.updates?.restart(); }
    catch (error) { setState(previous => previous && { ...previous, restarting: false, error: error instanceof Error ? error.message : String(error) }); }
  };
  return <div className="ml-auto flex min-w-0 items-center gap-2 pr-2">
    {state.error && <span role="alert" className="max-w-72 truncate text-xs text-destructive" title={state.error}>{state.error}</span>}
    <Button variant="ghost" size="sm" disabled={state.restarting} onClick={() => void restart()} title="Save your drafts and restart to apply the installed update">
      {state.restarting ? "Restarting…" : "Update ready · Restart"}
    </Button>
  </div>;
}
