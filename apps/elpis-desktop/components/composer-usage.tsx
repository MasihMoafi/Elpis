"use client";

import { countdown, tightest, useProviderUsage, windowLabel } from "@/components/provider-usage";
import { Button } from "@/components/ui/button";
import { Gauge } from "lucide-react";

/** The current connection's reported allowance, sharing the sidebar's account data and refresh. */
export function ComposerUsage({ provider, refreshKey, onOpen }: {
  provider: string;
  refreshKey: number;
  onOpen: () => void;
}) {
  const { data, error } = useProviderUsage(refreshKey);
  if (!data || error) return null;
  const account = provider === "claude" ? data.claude : provider === "gemini" ? data.gemini : null;
  const limits = provider === "openai"
    ? data.openai.auth.state === "signedIn" && data.openai.auth.method?.toLowerCase() === "chatgpt" && !data.openai.usageError
      ? data.openai.usage : []
    : account && !account.signedOut && !account.unavailable && account.state !== "notConnected" ? account.usage : [];
  const window = tightest(limits);
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  const remaining = Math.round(100 - Math.max(0, Math.min(100, window.usedPercent!)));
  const name = provider === "openai" ? "ChatGPT" : provider === "claude" ? "Anthropic" : "Antigravity";
  const detail = [`${name}: ${remaining}% left`, windowLabel(window.windowDurationMins), countdown(window.resetsAt)]
    .filter(Boolean).join(" · ");
  return (
    <Button type="button" variant="ghost" size="xs" className="composer-chip composer-account-usage"
      aria-label={`${name} usage: ${remaining}% left`} title={detail} onClick={onOpen}>
      <Gauge size={14} aria-hidden="true" />
      {remaining}% left
    </Button>
  );
}
