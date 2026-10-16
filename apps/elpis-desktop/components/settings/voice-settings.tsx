"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { api } from "@/lib/api";
import { SettingRow, SettingsActions, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";

type Backend = "openrouter" | "codex" | "local";
/** "auto" saves no explicit engine: the bridge then uses the ChatGPT sign-in while Elpis is signed in to ChatGPT, else Local. */
type Fallback = Backend | "auto";
type Route = { available: boolean; backend?: string; label?: string; reason?: string };
type VoiceServer = { name: string; enabled?: boolean; whispertype?: { backend: Backend | null; model: string | null } };
type VoiceConfig = { version: string | null; write: { available: boolean }; servers: VoiceServer[] };
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const FALLBACK_NOTE: Record<Fallback, string> = {
  auto: "Uses the ChatGPT sign-in while Elpis is signed in to ChatGPT, otherwise Local WhisperType.",
  local: "Audio stays on this computer. Uses your installed WhisperType model.",
  codex: "Audio goes to ChatGPT, using Elpis's ChatGPT sign-in.",
  openrouter: "Audio goes to OpenRouter, using the model above. OpenRouter charges per use.",
};

/** The two settings behind the microphone, saved in WhisperType's MCP env through the config writer: the OpenRouter model
 * (used by OpenRouter chats) and the fallback engine for chats on providers with no transcription Elpis can reach. */
function WhisperTypeSettings({ server, save, disabled = false }: { server: Pick<VoiceServer, "whispertype">; save: (body: Record<string, unknown>) => Promise<void>; disabled?: boolean }) {
  const [backend, setBackend] = useState<Fallback>(server.whispertype?.backend ?? "auto");
  const [model, setModel] = useState(server.whispertype?.model ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); event.stopPropagation(); if (busy || disabled) return; setBusy(true); setError(""); setSaved(false);
    try { await save({ action: "whispertype", backend: backend === "auto" ? null : backend, model: model.trim() || null }); setSaved(true); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} aria-label="Transcription settings">
    <SettingRow title="OpenRouter transcription model" description="For chats that run on OpenRouter. An OpenRouter model ID; it is required there.">
      <Input aria-label="OpenRouter transcription model" className="w-64 max-w-full" value={model} onChange={e => { setSaved(false); setModel(e.target.value); }} placeholder="openai/gpt-4o-mini-transcribe" disabled={disabled || busy} />
    </SettingRow>
    <SettingRow title="Fallback transcription" description={`For chats on Anthropic, Claude and Antigravity, which offer Elpis no transcription. ${FALLBACK_NOTE[backend]}`}>
      <OptionSelect aria-label="Fallback transcription engine" className="settings-choice" value={backend} disabled={disabled || busy} onChange={e => { setSaved(false); setBackend(e.target.value as Fallback); }}><option value="auto">Automatic</option><option value="local">Local WhisperType</option><option value="codex">ChatGPT sign-in</option><option value="openrouter">OpenRouter</option></OptionSelect>
    </SettingRow>
    <SettingsActions feedback={error ? <SettingsNotice tone="alert">{error}</SettingsNotice> : saved ? <SettingsNotice>Transcription settings saved.</SettingsNotice> : null}>
      <Button type="submit" variant="outline" size="sm" aria-label="Save transcription settings" disabled={disabled || busy}>{busy ? "Saving…" : "Save"}</Button>
    </SettingsActions>
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
    <SettingsHeader title="Voice" description="Dictate into the composer with the microphone button. A chat transcribes with its own provider: ChatGPT chats with the ChatGPT sign-in, Google Gemini chats with the Gemini API key, OpenRouter chats with the model below. Recordings are limited to two minutes or 8 MB." />
    {error && <SettingsNotice tone="alert">Could not read voice settings: {error}</SettingsNotice>}
    {!config && !error && <SettingsNotice>Reading voice settings…</SettingsNotice>}
    {config && <SettingsGroup title="Dictation">
      <SettingRow title="Status" description={route?.available ? "WhisperType is enabled. The first dictation checks that it runs." : route?.reason ?? "Status not reported."}>
        <span className={`settings-badge ${route?.available ? "ok" : "warn"}`}>{route?.available ? "Configured" : "Unavailable"}</span>
      </SettingRow>
      {server ? <WhisperTypeSettings server={server} disabled={!config.write?.available} save={save} />
        : <SettingRow title="WhisperType server" description="Dictation uses the whispertype MCP server. Add it under MCP servers."><Button variant="outline" size="sm" onClick={onOpenMcp}>Open MCP servers</Button></SettingRow>}
      {server && <SettingRow title="API keys" description="WhisperType's keys are managed with its MCP server."><Button variant="outline" size="sm" onClick={onOpenMcp}>Open MCP servers</Button></SettingRow>}
    </SettingsGroup>}
  </div>;
}
