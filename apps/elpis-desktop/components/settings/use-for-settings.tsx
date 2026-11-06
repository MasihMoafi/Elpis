"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { SettingRow, SettingsGroup, SettingsNotice } from "@/components/settings/rows";
import { api, subscriptionOf } from "@/lib/api";
import { errorText } from "@/lib/error-text.mjs";
import { editable, saveSettings, useElpisSettings } from "@/lib/settings-store";
import { speechModelUnavailable } from "@/lib/speech-model.mjs";
import { useModelCatalog } from "@/components/settings/maintenance";

type Provider = { id: string; name: string; baseUrl: string | null; auth: { keySet: boolean } };
type Choice = { source: string; model: string | null; voice: string | null };
type Model = { model: string; displayName: string; voices?: string[] };
type Mcp = { version: string | null; write: { available: boolean }; servers: { name: string; whispertype?: { backend: string | null; model: string | null; everyChat?: boolean; explicit?: boolean } }[] };
type Draft = { source: string; provider: string; model: string };
type LoadKey = "chatModels" | "speech" | "speechModels" | "voices" | "dictation" | "dictationModels";
type Row = "chat" | "speech" | "dictation";

function readChoice(value: Choice): Choice {
  if (!value || typeof value.source !== "string" || !value.source || (value.model !== null && typeof value.model !== "string") || (value.voice !== null && typeof value.voice !== "string")) throw Error("Invalid read aloud settings.");
  return value;
}

function readMcp(value: Mcp): Mcp {
  if (!value || !value.write || typeof value.write.available !== "boolean" || !Array.isArray(value.servers) || !value.servers.every(item => {
    const voice = item?.whispertype;
    return item && typeof item.name === "string" && (voice == null || (typeof voice === "object" && !Array.isArray(voice)
      && (voice.backend == null || typeof voice.backend === "string") && (voice.model == null || typeof voice.model === "string")
      && (voice.everyChat == null || typeof voice.everyChat === "boolean") && (voice.explicit == null || typeof voice.explicit === "boolean")));
  })) throw Error("Invalid dictation settings.");
  return value;
}

function openrouter(provider: Provider) {
  try { const url = new URL(provider.baseUrl ?? ""); return url.protocol === "https:" && url.hostname === "openrouter.ai" && url.pathname.replace(/\/+$/, "") === "/api/v1"; }
  catch { return false; }
}

/** The four controls save into their existing owners: config, speech preference and WhisperType. */
export function UseForSettings({ providers, refreshKey, active = true, chatgptAvailable = false }: { providers: Provider[]; refreshKey: number; active?: boolean; chatgptAvailable?: boolean }) {
  const { data: settings, error: settingsError } = useElpisSettings();
  const { models: sharedModels } = useModelCatalog();
  const [chatDraft, setChatDraft] = useState<Draft | null>(null);
  const chat = chatDraft ?? { source: subscriptionOf(settings?.main.model)?.prefix ?? settings?.main.provider ?? "", provider: settings?.main.provider ?? "", model: settings?.main.model ?? "" };
  const [speech, setSpeech] = useState<Choice>({ source: "local", model: null, voice: null });
  const [speechLoaded, setSpeechLoaded] = useState(false);
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [dictationDraft, setDictationDraft] = useState<{ backend: string; model: string } | null>(null);
  const [chatModels, setChatModels] = useState<Model[]>([]);
  const [speechModels, setSpeechModels] = useState<Model[]>([]);
  const [dictationModels, setDictationModels] = useState<Model[]>([]);
  const [localVoices, setLocalVoices] = useState<string[]>([]);
  const [localDefaultVoice, setLocalDefaultVoice] = useState("");
  const [error, setError] = useState<{ row: Row; message: string } | null>(null);
  const [unavailable, setUnavailable] = useState<Partial<Record<LoadKey, boolean>>>({});
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const server = mcp?.servers.find(item => item.name === "whispertype");
  const dictation = dictationDraft ?? { backend: server?.whispertype?.backend ?? "auto", model: server?.whispertype?.model ?? "" };
  const routers = providers.filter(openrouter);
  const router = routers.length === 1 ? routers[0] : null;
  const subscriptions = [{ prefix: "claude/", label: "Claude subscription" }, { prefix: "agy/", label: "Antigravity" }].filter(item => sharedModels.some(model => typeof model?.model === "string" && model.model.startsWith(item.prefix)));
  const markUnavailable = (key: LoadKey, failed: boolean) => setUnavailable(old => !!old[key] === failed ? old : { ...old, [key]: failed });
  const catalog = (url: string, set: (models: Model[]) => void, key: LoadKey) => {
    let active = true;
    set([]); markUnavailable(key, false);
    void api<{ data: Model[] }>(url).then(result => {
      if (!Array.isArray(result?.data) || !result.data.every(item => item && typeof item.model === "string" && (item.displayName == null || typeof item.displayName === "string") && (item.voices == null || (Array.isArray(item.voices) && item.voices.every(voice => typeof voice === "string"))))) throw Error("Invalid model choices.");
      if (active) set(result.data);
    }).catch(() => { if (active) markUnavailable(key, true); });
    return () => { active = false; };
  };
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setSpeechLoaded(false); setMcp(null); markUnavailable("speech", false); markUnavailable("dictation", false); markUnavailable("voices", false);
    setDictationDraft(null);
    void api<Choice>("/read-aloud/settings").then(readChoice).then(value => { if (alive) { setSpeech(value); setSpeechLoaded(true); } }).catch(() => { if (alive) markUnavailable("speech", true); });
    void api<Mcp>("/mcp").then(readMcp).then(value => { if (alive) setMcp(value); }).catch(() => { if (alive) markUnavailable("dictation", true); });
    return () => { alive = false; };
  }, [active, refreshKey]);
  useEffect(() => {
    if (!active) return;
    if (chat.source === "claude/" || chat.source === "agy/") { markUnavailable("chatModels", false); setChatModels(sharedModels.filter(item => typeof item?.model === "string" && item.model.startsWith(chat.source))); return; }
    return chat.provider ? catalog(`/models?provider=${encodeURIComponent(chat.provider)}`, setChatModels, "chatModels") : catalog("/models", setChatModels, "chatModels");
  }, [active, chat.source, chat.provider, settings?.version, sharedModels]);
  useEffect(() => {
    if (!active || !speechLoaded) return;
    markUnavailable("voices", false); markUnavailable("speechModels", false);
    if (speech.source === "local") {
      let active = true;
      setLocalVoices([]); setLocalDefaultVoice("");
      void api<{ voices: string[]; defaultVoice?: string }>("/read-aloud/voices").then(value => {
        if (!Array.isArray(value?.voices) || !value.voices.every(voice => typeof voice === "string") || (value.defaultVoice != null && typeof value.defaultVoice !== "string")) throw Error("Invalid voice choices.");
        if (active) { setLocalVoices(value.voices); setLocalDefaultVoice(value.defaultVoice ?? ""); }
      }).catch(() => { if (active) markUnavailable("voices", true); });
      return () => { active = false; };
    }
    if (!providers.some(item => item.id === speech.source && openrouter(item))) return;
    return catalog(`/models?provider=${encodeURIComponent(speech.source)}&outputModality=speech`, setSpeechModels, "speechModels");
  }, [active, speech.source, speechLoaded, refreshKey]); // providers refresh with refreshKey
  useEffect(() => {
    if (!active) return;
    if (!router) { setDictationModels([]); markUnavailable("dictationModels", false); return; }
    return catalog(`/models?provider=${encodeURIComponent(router.id)}&outputModality=transcription`, setDictationModels, "dictationModels");
  }, [active, router?.id, refreshKey]);
  async function perform(row: Row, action: () => Promise<unknown>, message: string) {
    if (busy) return; setBusy(true); setError(null); setNotice("");
    try { await action(); setNotice(message); } catch (cause) { setError({ row, message: errorText(cause) }); }
    finally { setBusy(false); }
  }
  const selectedSpeechModel = speechModels.find(item => item.model === speech.model);
  const speechVoices = speech.source === "local" ? localVoices : selectedSpeechModel?.voices ?? [];
  const speechNeedsVoice = speech.source !== "local" && speechVoices.length > 0 && !speech.voice;
  return <SettingsGroup title="Use for" description="Choose a source and model for each capability. API sources are paid per use.">
    {notice && <SettingsNotice>{notice}</SettingsNotice>}
    <SettingRow title="Chat" description="The Configuration default for new chats and the terminal.">
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect aria-label="Chat source" className="settings-choice" value={chat.source} disabled={!editable(settings) || busy || !!settings?.managed?.modelProvider} onChange={event => { const source = event.target.value; setChatDraft({ source, provider: source === "claude/" || source === "agy/" ? settings?.main.provider ?? "" : source, model: "" }); }}>
          <option value="">Default connection</option><option value="openai" disabled={!chatgptAvailable} data-hint={!chatgptAvailable ? "Sign in with ChatGPT first." : undefined}>ChatGPT</option>{subscriptions.map(item => <option key={item.prefix} value={item.prefix}>{item.label}</option>)}{(settings?.providers ?? []).filter(item => item.id !== "openai").map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
        </OptionSelect>
        <OptionSelect aria-label="Chat model" className="settings-choice" value={chat.model} disabled={!editable(settings) || busy || unavailable.chatModels} onChange={event => setChatDraft({ ...chat, model: event.target.value })}>
          <option value="" disabled>Choose model</option>{chat.model && !chatModels.some(item => item.model === chat.model) && <option value={chat.model}>{chat.model}</option>}{chatModels.map(item => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}
        </OptionSelect>
        <Button variant="outline" disabled={!editable(settings) || busy || !!unavailable.chatModels || !chatDraft || !chat.model} onClick={() => void perform("chat", async () => { await saveSettings("/settings", { version: settings?.version, main: { provider: chat.provider || null, model: chat.model } }); setChatDraft(null); }, "Chat default saved for new conversations.")}>Save</Button>
        {(!settings && settingsError) && <SettingsNotice tone="alert">Chat settings unavailable.</SettingsNotice>}
        {unavailable.chatModels && <SettingsNotice tone="alert">Chat model choices unavailable.</SettingsNotice>}
        {error?.row === "chat" && <SettingsNotice tone="alert">{error.message}</SettingsNotice>}
      </div>
    </SettingRow>
    <SettingRow title="Read aloud" description="Local Kokoro by default. An API source is paid per use.">
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect aria-label="Read aloud source" className="settings-choice" value={speech.source} disabled={!speechLoaded || busy} onChange={event => setSpeech({ source: event.target.value, model: null, voice: null })}>
          <option value="local">Local Kokoro</option>{providers.filter(item => item.id !== "local").map(item => <option key={item.id} value={item.id} disabled={!openrouter(item) || !item.auth.keySet} data-hint={!openrouter(item) ? "Speech support is not available." : !item.auth.keySet ? "Add an API key first." : "Paid per use."}>{item.name}</option>)}
        </OptionSelect>
        <OptionSelect aria-label="Read aloud model" className="settings-choice" value={speech.source === "local" ? "kokoro" : speech.model ?? ""} disabled={!speechLoaded || busy || speech.source === "local"} onChange={event => setSpeech({ ...speech, model: event.target.value, voice: null })}>
          {speech.source === "local" ? <option value="kokoro">Kokoro</option> : <><option value="" disabled>Choose model</option>{speech.model && !speechModels.some(item => item.model === speech.model) && <option value={speech.model}>{speech.model}</option>}{speechModels.map(item => <option key={item.model} value={item.model} disabled={!!speechModelUnavailable(item.model)} data-hint={speechModelUnavailable(item.model) ?? undefined}>{item.displayName || item.model}</option>)}</>}
        </OptionSelect>
        {speechVoices.length > 0 && <OptionSelect aria-label="Read aloud voice" className="settings-choice" value={speech.voice ?? ""} disabled={busy} onChange={event => setSpeech({ ...speech, voice: event.target.value || null })}>
          <option value="" disabled={speech.source !== "local"}>{speech.source === "local" ? `Default voice${localDefaultVoice ? ` (${localDefaultVoice})` : ""}` : "Choose voice"}</option>{speechVoices.map(voice => <option key={voice} value={voice}>{voice}</option>)}
        </OptionSelect>}
        <Button variant="outline" disabled={!speechLoaded || busy || (speech.source !== "local" && (!selectedSpeechModel || !!speechModelUnavailable(selectedSpeechModel.model) || speechNeedsVoice))} onClick={() => void perform("speech", async () => { setSpeech(readChoice(await api<Choice>("/read-aloud/settings", speech))); window.dispatchEvent(new Event("elpis-read-aloud-settings")); }, "Read aloud source saved.")}>Save</Button>
        {unavailable.speech && <SettingsNotice tone="alert">Read aloud settings unavailable.</SettingsNotice>}
        {unavailable.speechModels && <SettingsNotice tone="alert">Speech model choices unavailable.</SettingsNotice>}
        {unavailable.voices && <SettingsNotice tone="alert">Voice choices unavailable.</SettingsNotice>}
        {error?.row === "speech" && <SettingsNotice tone="alert">{error.message}</SettingsNotice>}
      </div>
    </SettingRow>
    <SettingRow title="Live voice" description={chatgptAvailable ? "ChatGPT subscription. Other sources do not support live voice here." : "Sign in with ChatGPT to use live voice."}>
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect aria-label="Live voice source" className="settings-choice" value="chatgpt" onChange={() => {}}>
          <option value="chatgpt" disabled={!chatgptAvailable} data-hint={!chatgptAvailable ? "Sign in with ChatGPT first." : undefined}>ChatGPT subscription</option><option value="local" disabled data-hint="Live voice is not available for this source.">Local</option><option value="claude" disabled data-hint="Live voice is not available for this source.">Claude</option>{providers.filter(item => item.id !== "local" && item.id !== "claude" && item.id !== "chatgpt").map(item => <option key={item.id} value={item.id} disabled data-hint="Live voice is not available for this source.">{item.name}</option>)}
        </OptionSelect>
        <OptionSelect aria-label="Live voice model" className="settings-choice" value="gpt-live-1.1-codex" disabled><option value="gpt-live-1.1-codex">ChatGPT live voice</option></OptionSelect>
      </div>
    </SettingRow>
    <SettingRow title="Dictation" description={unavailable.dictation ? "WhisperType settings could not be read." : !server ? "Add WhisperType under Settings → MCP servers." : server.whispertype?.explicit ? "The Voice setting applies to every chat." : "The current Voice fallback may vary by chat. Save here to use one source everywhere."}>
      <div className="flex flex-wrap items-center gap-2">
        <OptionSelect aria-label="Dictation source" className="settings-choice" value={dictation.backend} disabled={!server || !mcp?.write.available || busy} onChange={event => setDictationDraft({ ...dictation, backend: event.target.value })}>
          <option value="auto">Automatic</option><option value="local">Local WhisperType</option><option value="codex" disabled={!chatgptAvailable} data-hint={!chatgptAvailable ? "Sign in with ChatGPT first." : undefined}>ChatGPT subscription</option><option value="openrouter" disabled={!router?.auth.keySet} data-hint={routers.length > 1 ? "Keep one OpenRouter connection for dictation." : !router?.auth.keySet ? "Add one OpenRouter API key first." : "Paid per use."}>OpenRouter</option>
          {providers.filter(item => !openrouter(item)).map(item => <option key={item.id} value={`unsupported-${item.id}`} disabled data-hint="Dictation is not available for this source.">{item.name}</option>)}
        </OptionSelect>
        <OptionSelect aria-label="Dictation model" className="settings-choice" value={dictation.backend === "openrouter" ? dictation.model : "default"} disabled={!server || !mcp?.write.available || busy || !!unavailable.dictationModels || dictation.backend !== "openrouter"} onChange={event => setDictationDraft({ ...dictation, model: event.target.value })}>
          {dictation.backend !== "openrouter" ? <option value="default">Source default</option> : <><option value="">Choose model</option>{dictation.model && !dictationModels.some(item => item.model === dictation.model) && <option value={dictation.model}>{dictation.model}</option>}{dictationModels.map(item => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}</>}
        </OptionSelect>
        <Button variant="outline" disabled={!server || !mcp?.write.available || busy || dictation.backend === "auto" || (dictation.backend === "codex" && !chatgptAvailable) || (dictation.backend === "openrouter" && (!router?.auth.keySet || !dictation.model || !!unavailable.dictationModels))} onClick={() => void perform("dictation", async () => { setMcp(readMcp(await api<Mcp>("/mcp", { version: mcp?.version, name: "whispertype", action: "whispertype", backend: dictation.backend, model: dictation.model || null, everyChat: true }))); setDictationDraft(null); }, "Dictation source saved for every chat.")}>Save</Button>
        {unavailable.dictation && <SettingsNotice tone="alert">Dictation settings unavailable.</SettingsNotice>}
        {unavailable.dictationModels && <SettingsNotice tone="alert">Dictation model choices unavailable.</SettingsNotice>}
        {error?.row === "dictation" && <SettingsNotice tone="alert">{error.message}</SettingsNotice>}
      </div>
    </SettingRow>
  </SettingsGroup>;
}
