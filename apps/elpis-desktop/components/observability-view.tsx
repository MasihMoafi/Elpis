"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsNotice } from "@/components/settings/rows";
import { api } from "@/lib/api";

/** The TUI owns the dashboard. Desktop only provides its authenticated transport and frame. */
export function ObservabilityView({ threadId, dark }: { threadId?: string; dark: boolean }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  const currentDark = useRef(dark); currentDark.current = dark;
  const syncTheme = () => frame.current?.contentWindow?.postMessage({ type: "elpis-dashboard-theme", theme: dark ? "elpis-dashboard" : "light" }, location.origin);
  useEffect(syncTheme, [dark]);
  useEffect(() => {
    const controller = new AbortController();
    setUrl(""); setError("");
    void api<{ url: string }>(`/dashboard${threadId ? `?thread=${encodeURIComponent(threadId)}` : ""}`, undefined, controller.signal)
      .then(result => {
        if (controller.signal.aborted) return;
        if (!result.url?.startsWith("/api/dashboard/")) throw Error("Dashboard address unavailable. Update Elpis and retry.");
        const address = new URL(result.url, location.origin);
        address.searchParams.set("theme", currentDark.current ? "elpis-dashboard" : "light");
        setUrl(address.pathname + address.search + address.hash);
      }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [threadId, retry]);
  return <div className="observability" data-view="observability" aria-label="Observability">
    {error ? <SettingsNotice tone="alert">{error} <Button variant="ghost" size="sm" onClick={() => setRetry(value => value + 1)}>Retry</Button></SettingsNotice>
      : url ? <iframe ref={frame} title="Elpis dashboard" src={url} onLoad={syncTheme} /> : <SettingsNotice>Loading dashboard…</SettingsNotice>}
  </div>;
}
