"use client";

import { FilePathText } from "@/components/file-ref";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { api, unreadable } from "@/lib/api";
import { RefreshButton, SaveFeedback, SettingRow, SettingsEmpty, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";

type Hook = { key: string; event: string | null; handler: string | null; command: string | null; server: string | null; tool: string | null; matcher: string | null; timeoutSec: number | null; statusMessage: string | null; source: string | null; sourcePath: string | null; pluginId: string | null; enabled: boolean; managed: boolean; trust: string | null };
type Hooks = { version: string | null; write: { available: boolean }; hooks: Hook[]; warnings: string[]; errors: { path: string | null; message: string }[] };

function readHooks(data: Hooks): Hooks {
  if (![data.hooks, data.warnings, data.errors].every(Array.isArray)) throw unreadable("hooks");
  return data;
}

const EVENTS: Record<string, string> = {
  preToolUse: "Before a tool runs", postToolUse: "After a tool runs", permissionRequest: "Permission request", preCompact: "Before compaction", postCompact: "After compaction",
  sessionStart: "Session start", sessionEnd: "Session end", userPromptSubmit: "Message sent", subagentStart: "Agent starts", subagentStop: "Agent stops", stop: "Turn ends", interrupt: "Turn interrupted",
};
const TRUST: Record<string, { label: string; tone: string }> = {
  trusted: { label: "Trusted", tone: "ok" }, managed: { label: "Managed", tone: "" }, untrusted: { label: "Not trusted", tone: "warn" }, modified: { label: "Changed since trusted", tone: "warn" },
};
const action = (hook: Hook) => hook.handler === "command" ? hook.command : hook.handler === "mcpTool" ? `${hook.server}.${hook.tool}` : hook.handler;

/** Settings → Hooks: what Elpis discovered (config, hooks.json, plugins); enable or trust each one in `hooks.state`. */
export function HooksSettings() {
  const [data, setData] = useState<Hooks | null>(null);
  const [error, setError] = useState("");
  const saver = useSaver();
  const load = useCallback(async () => { try { setData(readHooks(await api<Hooks>("/hooks"))); setError(""); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } }, []);
  useEffect(() => { void load(); }, [load]);
  const change = (hook: Hook, body: { enabled: boolean } | { trust: true }, done: string) => void saver.run(hook.key, async () => {
    try { setData(readHooks(await api<Hooks>("/hooks", { version: data?.version, key: hook.key, ...body }))); } catch (e) { await load(); throw e; }
  }, done);
  return <div aria-label="Hooks">
    <SettingsHeader title="Hooks" description="Lifecycle hooks from your Elpis config, hooks.json and enabled plugins. A hook runs only when it is on and trusted." action={<RefreshButton onClick={() => void load()} />} />
    {error && <SettingsNotice tone="alert">Could not read hooks: {error}</SettingsNotice>}
    {!data && !error && <SettingsNotice>Reading hooks…</SettingsNotice>}
    {data && !data.hooks.length && <SettingsEmpty title="No hooks found">Configured hooks will appear here.</SettingsEmpty>}
    {data && data.hooks.length > 0 && <SettingsGroup>
      {data.hooks.map(hook => {
        const trust = TRUST[hook.trust ?? ""] ?? { label: hook.trust ?? "Trust not reported", tone: "" };
        const label = `${EVENTS[hook.event ?? ""] ?? hook.event ?? "Hook"}${hook.matcher ? ` · ${hook.matcher}` : ""}`;
        return <SettingRow key={hook.key} title={label} description={<>
          <code className="settings-code">{action(hook)}</code>
          <span className="mt-1 block"><FilePathText text={[hook.pluginId ? `Plugin ${hook.pluginId}` : hook.source, hook.sourcePath, hook.timeoutSec ? `${hook.timeoutSec}s timeout` : null].filter(Boolean).join(" · ")} /></span>
        </>}>
          <span className={`settings-badge ${trust.tone}`}>{trust.label}</span>
          {(hook.trust === "untrusted" || hook.trust === "modified") && <Button variant="outline" disabled={!data.write?.available || saver.pending !== null} onClick={() => change(hook, { trust: true }, "Hook trusted.")}>Trust</Button>}
          <Switch aria-label={`Enable ${label}`} checked={hook.enabled} disabled={hook.managed || !data.write?.available || saver.pending !== null} onCheckedChange={enabled => change(hook, { enabled }, enabled ? "Hook turned on." : "Hook turned off.")} />
        </SettingRow>;
      })}
    </SettingsGroup>}
    <SaveFeedback outcome={saver.outcome} onReload={() => void load()} />
    {data && [...data.warnings, ...data.errors.map(item => `${item.path ? `${item.path}: ` : ""}${item.message}`)].map(text => <SettingsNotice key={text} tone="alert">{text}</SettingsNotice>)}
  </div>;
}
