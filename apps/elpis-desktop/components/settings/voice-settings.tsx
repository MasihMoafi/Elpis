"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { api } from "@/lib/api";
import { SettingRow, SettingsActions, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";

type Backend = "openrouter" | "codex" | "local";
type Route = { available: boolean; backend?: string; label?: string; reason?: string };
type VoiceServer = { name: string; enabled?: boolean; whispertype?: { backend: Backend; model: string | null } };
type VoiceConfig = { version: string | null; write: { available: boolean }; servers: VoiceServer[] };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const NOTE: Record<Backend, string> = {
  local: "Audio stays on this computer. Uses your installed WhisperType model.",
  codex: "Uses WhisperType's existing ChatGPT sign-in for cloud transcription.",
  openrouter: "Audio uses your configured OpenRouter transcription model and credentials.",
};

/** The WhisperType route the composer microphone uses, saved in its MCP server's env through the config writer.
 * `rows` lays it out as Settings rows; the composer's popover uses the compact form. */
export function WhisperTypeSettings({ server, save, disabled = false, layout = "form" }: { server: Pick<VoiceServer, "whispertype">; save: (body: Record<string, unknown>) => Promise<void>; disabled?: boolean; layout?: "form" | "rows" }) {
  const [backend, setBackend] = useState<Backend>(server.whispertype?.backend ?? "openrouter");
  const [model, setModel] = useState(server.whispertype?.model ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); event.stopPropagation(); if (busy || disabled) return; setBusy(true); setError(""); setSaved(false);
    try { await save({ action: "whispertype", backend, ...(backend === "openrouter" ? { model: model.trim() || null } : {}) }); setSaved(true); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const engine = <OptionSelect aria-label="Transcription engine" className={layout === "rows" ? "settings-choice" : "w-full"} value={backend} disabled={disabled || busy} onChange={e => { setSaved(false); setBackend(e.target.value as Backend); }}><option value="local">Local WhisperType</option><option value="openrouter">OpenRouter</option><option value="codex">ChatGPT sign-in</option></OptionSelect>;
  const modelInput = <Input aria-label="Transcription model" className={layout === "rows" ? "w-64 max-w-full" : undefined} value={model} onChange={e => { setSaved(false); setModel(e.target.value); }} placeholder="openai/gpt-4o-mini-transcribe" disabled={disabled || busy} />;
  const submitButton = <Button type="submit" variant="outline" size={layout === "rows" ? "sm" : "default"} aria-label="Save transcription settings" disabled={disabled || busy}>{busy ? "Saving…" : "Save"}</Button>;
  if (layout === "rows") return <form onSubmit={submit} aria-label="Transcription settings">
    <SettingRow title="Transcription engine" description={NOTE[backend]}>{engine}</SettingRow>
    {backend === "openrouter" && <SettingRow title="Transcription model" description="OpenRouter model ID. Leave empty for WhisperType's default.">{modelInput}</SettingRow>}
    <SettingsActions feedback={error ? <SettingsNotice tone="alert">{error}</SettingsNotice> : saved ? <SettingsNotice>Transcription settings saved.</SettingsNotice> : null}>{submitButton}</SettingsActions>
  </form>;
  return <form className="grid gap-3" onSubmit={submit}>
    <label className="field">Transcription engine{engine}</label>
    {backend === "openrouter" && <label className="field">Transcription model{modelInput}</label>}
    <p className="text-xs text-muted-foreground">{NOTE[backend]}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {submitButton}
  </form>;
}

/** Settings → Voice: dictation status and route, backed by the whispertype MCP server. */
export function VoiceSettings({ onOpenMcp }: { onOpenMcp: () => void }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try { const [mcp, status] = await Promise.all([api<VoiceConfig>("/mcp"), api<Route>("/tools/transcription")]); setConfig(mcp); setRoute(status); }
    catch (e) { setError(message(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const server = config?.servers.find(item => item.name === "whispertype");
  async function save(body: Record<string, unknown>) {
    try { setConfig(await api<VoiceConfig>("/mcp", { version: config?.version, name: "whispertype", ...body })); setRoute(await api<Route>("/tools/transcription")); }
    catch (e) { await load(); throw e; }
  }
  return <div aria-label="Voice">
    <SettingsHeader title="Voice" description="Dictate into the composer with the microphone button. Recordings are limited to two minutes or 8 MB." />
    {error && <SettingsNotice tone="alert">Could not read voice settings: {error}</SettingsNotice>}
    {!config && !error && <SettingsNotice>Reading voice settings…</SettingsNotice>}
    {config && <SettingsGroup title="Dictation">
      <SettingRow title="Status" description={route?.available ? `Ready. Transcribes with ${route.label ?? route.backend}.` : route?.reason ?? "Status not reported."}>
        <span className={`settings-badge ${route?.available ? "ok" : "warn"}`}>{route?.available ? "Ready" : "Unavailable"}</span>
      </SettingRow>
      {server ? <WhisperTypeSettings layout="rows" server={server} disabled={!config.write?.available} save={save} />
        : <SettingRow title="WhisperType server" description="Dictation uses the whispertype MCP server. Add it under MCP servers."><Button variant="outline" size="sm" onClick={onOpenMcp}>Open MCP servers</Button></SettingRow>}
      {server && <SettingRow title="API keys" description="WhisperType's keys are managed with its MCP server."><Button variant="outline" size="sm" onClick={onOpenMcp}>Open MCP servers</Button></SettingRow>}
    </SettingsGroup>}
  </div>;
}
