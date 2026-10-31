"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { subscribeLoveSpotEvents } from "@/lib/love-spot-events";

/** The one Matilda setting the bridge keeps (bridge/love-spot-store.cjs, matildaSettings): whether she answers, and her
 * model. The board, the small chat and her chat tab all read this, so she is the same Matilda everywhere. */
export type MatildaSettings = { replies: boolean; model: string | null; provider: string | null };

export function useMatildaSettings() {
  const [settings, setSettings] = useState<MatildaSettings | null>(null);
  useEffect(() => {
    let live = true;
    void api<MatildaSettings>("/love-spot/matilda").then(value => { if (live) setSettings(value); }).catch(() => {});
    // The Love Spot stream every window already keeps open carries changes; no extra connection per window.
    const stop = subscribeLoveSpotEvents(event => {
      try { const data = JSON.parse(event.data); if (live && data?.type === "matilda" && typeof data.matilda?.replies === "boolean") setSettings(data.matilda); } catch { /* not a settings update */ }
    });
    return () => { live = false; stop(); };
  }, []);
  const update = useCallback(async (change: Partial<MatildaSettings>) => {
    setSettings(current => current && { ...current, ...change });
    const snapshot = await api<{ matilda: MatildaSettings }>("/love-spot/matilda", change);
    setSettings(snapshot.matilda);
  }, []);
  return { settings, update };
}
