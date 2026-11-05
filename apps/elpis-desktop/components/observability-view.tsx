"use client";

import { SettingsNotice } from "@/components/settings/rows";

/** Observability is the TUI's /dashboard page (apps/elpis-trajectory, DeepSeek Harness's Trajectory tab), served by the
 * bridge with the selected chat's rollout (5 Nov, Masih: "it already was there", A132, R33). */
export function ObservabilityView({ threadId }: { threadId?: string }) {
  return <div className="observability" data-view="observability" aria-label="Observability">
    {threadId ? <iframe key={threadId} title="Trajectory" src={`/trajectory/index.html?thread=${encodeURIComponent(threadId)}`} />
      : <SettingsNotice>Open a chat to see its trajectory.</SettingsNotice>}
  </div>;
}
