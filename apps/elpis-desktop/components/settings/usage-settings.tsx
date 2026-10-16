"use client";

import { openAIUsage, subscriptionUsage, useProviderUsage, UsageWindows, type UsageStatus } from "@/components/provider-usage";
import { RefreshButton, SettingsHeader, SettingsNotice } from "@/components/settings/rows";

/** Plan limits each signed-in account reports. Reloads when an account changes. */
export function UsageSettings({ refreshKey }: { refreshKey: number }) {
  const { data, error, loading, load } = useProviderUsage(refreshKey);
  const cards: [string, string, UsageStatus | null][] = data ? [
    ["openai", "OpenAI / ChatGPT", openAIUsage(data.openai)],
    ["claude", "Anthropic", subscriptionUsage(data.claude, "Claude", "Sign in with Claude Code")],
    ["gemini", "Antigravity", subscriptionUsage(data.gemini, "Antigravity", "Sign in to Antigravity")],
  ] : [];
  return <div aria-label="Usage and limits">
    <SettingsHeader title="Usage & limits" description="Limits reported by each connected account." action={<RefreshButton disabled={loading} onClick={() => void load()} />} />
    {error && <SettingsNotice tone="alert">Usage unavailable: {error}</SettingsNotice>}
    {!data && !error && <SettingsNotice>Loading usage…</SettingsNotice>}
    {cards.length > 0 && <div className="settings-stack">{cards.map(([id, name, status]) => <section key={id} className="usage-card settings-card" data-provider={id} aria-label={`${name} usage`}>
      <h3>{name}</h3>{status && <UsageWindows status={status} />}
    </section>)}</div>}
  </div>;
}
