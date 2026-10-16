"use client";

import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openAIUsage, subscriptionUsage, useProviderUsage, UsageWindows, type UsageStatus } from "@/components/provider-usage";
import { ConversationContext } from "@/components/settings/conversation-context";
import { SettingsHeader, SettingsNotice } from "@/components/settings/rows";

/** Plan limits each signed-in account reports, then the selected chat's context. Reloads when an account changes. */
export function UsageSettings({ refreshKey, threadId, active }: { refreshKey: number; threadId?: string; active: boolean }) {
  const { data, error, loading, load } = useProviderUsage(refreshKey);
  const cards: [string, string, UsageStatus | null][] = data ? [
    ["openai", "OpenAI / ChatGPT", openAIUsage(data.openai)],
    ["claude", "Anthropic", subscriptionUsage(data.claude, "Claude", "Sign in with Claude Code")],
    ["gemini", "Antigravity", subscriptionUsage(data.gemini, "Antigravity", "Sign in to Antigravity")],
  ] : [];
  return <div aria-label="Usage and limits">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <SettingsHeader title="Usage & limits" description="Limits reported by each connected account, and the selected chat's context." />
      <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}><RefreshCw size={14} />Refresh</Button>
    </div>
    {error && <div className="mb-6"><SettingsNotice tone="alert">Usage unavailable: {error}</SettingsNotice></div>}
    {!data && !error && <div className="mb-6"><SettingsNotice>Loading usage…</SettingsNotice></div>}
    {cards.length > 0 && <div className="mb-6 grid gap-3">{cards.map(([id, name, status]) => <section key={id} className="usage-card settings-card" data-provider={id} aria-label={`${name} usage`}>
      <h3>{name}</h3>{status && <UsageWindows status={status} />}
    </section>)}</div>}
    <ConversationContext threadId={threadId} active={active} />
  </div>;
}
