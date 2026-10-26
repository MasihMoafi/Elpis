"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { api, unreadable, type Model } from "@/lib/api";
import { SettingRow, SettingsActions, SettingsGroup, SettingsHeader, SettingsNotice } from "@/components/settings/rows";

type Backend = "openrouter" | "codex" | "local";
/** "auto" saves no explicit engine: the bridge then uses the ChatGPT sign-in while Elpis is signed in to ChatGPT, else Local. */
type Fallback = Backend | "auto";
type Route = { available: boolean; backend?: string; label?: string; reason?: string };
type VoiceServer = { name: string; enabled?: boolean; whispertype?: { backend: Backend | null; model: string | null } };
type VoiceConfig = { version: string | null; write: { available: boolean }; servers: VoiceServer[] };
function readVoice(data: VoiceConfig): VoiceConfig {
  if (!Array.isArray(data.servers)) throw unreadable("voice settings");
  return data;
}
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const FALLBACK_NOTE: Record<Fallback, string> = {
  auto: "Uses the ChatGPT sign-in while Elpis is signed in to ChatGPT, otherwise Local WhisperType.",
  local: "Audio stays on this computer. Uses your installed WhisperType model.",
  codex: "Audio goes to ChatGPT, using Elpis's ChatGPT sign-in.",
  openrouter: "Audio goes to OpenRouter, using the model above. OpenRouter charges per use.",
};

/** The two settings behind the microphone, saved in WhisperType's MCP env through the config writer: the OpenRouter model
 * (used by OpenRouter chats) and the fallback engine for chats on providers with no transcription Elpis can reach. */
function WhisperTypeSettings({ server, save, active, refreshKey, disabled = false }: { server: Pick<VoiceServer, "whispertype">; save: (body: Record<string, unknown>) => Promise<void>; active: boolean; refreshKey: number; disabled?: boolean }) {
  const [backendDraft, setBackendDraft] = useState<Fallback | null>(null), [modelDraft, setModelDraft] = useState<string | null>(null);
  const savedBackend = server.whispertype?.backend ?? "auto", savedModel = server.whispertype?.model ?? "";
  const backend = backendDraft ?? savedBackend, model = modelDraft ?? savedModel;
  const [models, setModels] = useState<Model[]>([]);
  const [catalogStatus, setCatalogStatus] = useState("Loading OpenRouter audio models…");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setCatalogStatus("Loading OpenRouter audio models…");
    api<{ data: Model[] }>("/models?provider=openrouter&inputModality=audio").then(result => {
      if (!Array.isArray(result?.data)) throw unreadable("OpenRouter audio models");
      if (!disposed) { setModels(result.data); setCatalogStatus(result.data.length ? "" : "OpenRouter returned no models that accept audio input."); }
    }).catch(e => { if (!disposed) setCatalogStatus(`OpenRouter models unavailable: ${message(e)}`); });
    return () => { disposed = true; };
  }, [active, refreshKey]);
  const customModels = [...new Set([server.whispertype?.model, model])].filter((value): value is string => !!value && !models.some(item => item.model === value));
  async function submit(event: React.FormEvent) {
    event.preventDefault(); event.stopPropagation(); if (busy || disabled) return; setBusy(true); setError(""); setSaved(false);
    try { await save({ action: "whispertype", backend: backend === "auto" ? null : backend, model: model.trim() || null }); setBackendDraft(null); setModelDraft(null); setSaved(true); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <form onSubmit={submit} aria-label="Transcription settings">
    <SettingRow title="OpenRouter transcription model" description="For chats that run on OpenRouter. Choose a model that accepts audio input; it is required there.">
      <div className="settings-field-stack text-sm">
        <OptionSelect aria-label="OpenRouter transcription model" aria-describedby="openrouter-transcription-status" className="settings-choice" value={model} disabled={disabled || busy || (!models.length && !model)} onChange={e => { setSaved(false); setModelDraft(e.target.value === savedModel ? null : e.target.value); }}>
          <option value="">Not set</option>
          {customModels.map(value => <option key={value} value={value}>{value}</option>)}
          {models.map(item => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}
        </OptionSelect>
        <span id="openrouter-transcription-status" role="status" className="text-xs text-muted-foreground">{catalogStatus}</span>
        <details><DisclosureSummary className="cursor-pointer">Advanced: custom model</DisclosureSummary>
          <Input aria-label="Custom OpenRouter transcription model" value={model} onChange={e => { setSaved(false); setModelDraft(e.target.value === savedModel ? null : e.target.value); }} maxLength={200} disabled={disabled || busy} />
        </details>
      </div>
    </SettingRow>
    <SettingRow title="Fallback transcription" description={`For chats on Anthropic, Claude and Antigravity, which offer Elpis no transcription. ${FALLBACK_NOTE[backend]}`}>
      <OptionSelect aria-label="Fallback transcription engine" className="settings-choice" value={backend} disabled={disabled || busy} onChange={e => { setSaved(false); setBackendDraft(e.target.value === savedBackend ? null : e.target.value as Fallback); }}><option value="auto">Automatic</option><option value="local">Local WhisperType</option><option value="codex">ChatGPT sign-in</option><option value="openrouter">OpenRouter</option></OptionSelect>
    </SettingRow>
    <SettingsActions feedback={error ? <SettingsNotice tone="alert">{error}</SettingsNotice> : saved ? <SettingsNotice>Transcription settings saved.</SettingsNotice> : null}>
      <Button type="submit" variant="outline" aria-label="Save transcription settings" disabled={disabled || busy}>{busy ? "Saving…" : "Save"}</Button>
    </SettingsActions>
  </form>;
}

type Speaking = { available: boolean; voices?: string[]; voice?: string };
const named = (voice: string) => voice.charAt(0).toUpperCase() + voice.slice(1);

/** The voice a voice chat speaks in: the voices the ChatGPT connection offers, saved as Elpis's `realtime.voice` and used from the next call
 * (Masih, 23 Oct: "make it configurable, the voice that is"). Without a ChatGPT sign-in there is nothing to choose, and the row says so. */
function VoiceChoice({ active, refreshKey }: { active: boolean; refreshKey: number }) {
  const [speaking, setSpeaking] = useState<Speaking | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const request = useRef(0), showing = useRef(active);
  const load = useCallback(async () => {
    const read = ++request.current;
    try { const value = await api<Speaking>("/voice"); if (read === request.current) { setSpeaking(value); setError(""); } }
    catch (e) { if (read === request.current) setError(message(e)); }
  }, []);
  useEffect(() => { showing.current = active; if (active) void load(); return () => { showing.current = false; request.current++; }; }, [active, refreshKey, load]);
  async function choose(voice: string) {
    const write = ++request.current;
    setBusy(true); setError(""); setSaved(false);
    try { const value = await api<Speaking>("/voice/choice", { voice }); if (write === request.current) setSpeaking(value); else if (showing.current) await load(); setSaved(true); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const voices = speaking?.available ? speaking.voices ?? [] : [];
  return <SettingsGroup title="Voice chat">
    <SettingRow title="Voice" description={`${speaking && !speaking.available ? "Connect ChatGPT under Settings → Models & accounts to choose a voice. " : ""}ChatGPT voices for new voice chats. Claude's voices are only available in Anthropic's apps.`}>
      <OptionSelect aria-label="Voice chat voice" className="settings-choice" value={voices.length ? speaking?.voice ?? "" : ""} disabled={busy || !voices.length} onChange={e => void choose(e.target.value)}>
        {voices.length ? voices.map(voice => <option key={voice} value={voice}>{named(voice)}</option>) : <option value="">{speaking ? "Unavailable" : "Reading…"}</option>}
      </OptionSelect>
    </SettingRow>
    {(error || saved) && <SettingsActions feedback={error ? <SettingsNotice tone="alert">{error}</SettingsNotice> : <SettingsNotice>Voice saved.</SettingsNotice>} />}
  </SettingsGroup>;
}

/** Settings → Voice: the voice chat's voice, then dictation status and route, backed by the whispertype MCP server. */
export function VoiceSettings({ onOpenMcp, active = true, refreshKey = 0 }: { onOpenMcp: () => void; active?: boolean; refreshKey?: number }) {
  const [config, setConfig] = useState<VoiceConfig | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0), showing = useRef(active);
  const load = useCallback(async () => {
    const read = ++request.current; setError(""); setLoading(true);
    try { const [mcp, status] = await Promise.all([api<VoiceConfig>("/mcp"), api<Route>("/tools/transcription")]); const config = readVoice(mcp); if (read === request.current) { setConfig(config); setRoute(status); } }
    catch (e) { if (read === request.current) setError(message(e)); }
    finally { if (read === request.current) setLoading(false); }
  }, []);
  useEffect(() => { showing.current = active; if (active) void load(); return () => { showing.current = false; request.current++; }; }, [active, refreshKey, load]);
  const server = config?.servers.find(item => item.name === "whispertype");
  async function save(body: Record<string, unknown>) {
    const write = ++request.current;
    try {
      const next = readVoice(await api<VoiceConfig>("/mcp", { version: config?.version, name: "whispertype", ...body }));
      if (write !== request.current) { if (showing.current) await load(); return; }
      setConfig(next);
      const status = await api<Route>("/tools/transcription");
      if (write === request.current) { setRoute(status); setLoading(false); }
    }
    catch (e) { await load(); throw e; }
  }
  return <div aria-label="Voice">
    <SettingsHeader title="Voice" />
    {error && <SettingsNotice tone="alert">Could not read voice settings: {error}</SettingsNotice>}
    {!config && !error && <SettingsNotice>Reading voice settings…</SettingsNotice>}
    <VoiceChoice active={active} refreshKey={refreshKey} />
    {config && <SettingsGroup title="Dictation">
      <SettingRow title="Status" description={route?.available ? "WhisperType is enabled. The first dictation checks that it runs." : route?.reason ?? "Status not reported."}>
        <span className={`settings-badge ${route?.available ? "ok" : "warn"}`}>{route?.available ? "Configured" : "Unavailable"}</span>
      </SettingRow>
      {server ? <details><DisclosureSummary className="cursor-pointer px-4 py-3 text-sm text-muted-foreground">Advanced: transcription</DisclosureSummary><WhisperTypeSettings server={server} active={active} refreshKey={refreshKey} disabled={!config.write?.available || loading} save={save} /></details>
        : <SettingRow title="WhisperType server" description="Dictation uses the whispertype MCP server. Add it under MCP servers."><Button variant="outline" onClick={onOpenMcp}>Open MCP servers</Button></SettingRow>}
    </SettingsGroup>}
  </div>;
}
