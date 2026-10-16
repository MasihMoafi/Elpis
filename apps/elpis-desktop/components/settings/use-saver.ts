"use client";

import { useEffect, useRef, useState } from "react";

/** Runs one save at a time for a group and keeps its outcome for SaveFeedback. */
export function useSaver() {
  const [pending, setPending] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const mounted = useRef(true), busy = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run(key: string, action: () => Promise<unknown>, success: string) {
    if (busy.current) return false;
    busy.current = true; setPending(key); setOutcome(null);
    try { await action(); if (mounted.current) setOutcome({ ok: true, text: success }); return true; }
    catch (error) { if (mounted.current) setOutcome({ ok: false, text: error instanceof Error ? error.message : String(error) }); return false; }
    finally { busy.current = false; if (mounted.current) setPending(null); }
  }
  return { pending, outcome, run, clear: () => setOutcome(null) };
}
