"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { OptionSelect } from "@/components/ui/option-select";
import { SettingsNotice } from "@/components/settings/rows";
import { api } from "@/lib/api";
import { errorText } from "@/lib/error-text.mjs";
import { editable, saveSettings, useElpisSettings } from "@/lib/settings-store";
import { speechModelUnavailable } from "@/lib/speech-model.mjs";

export type KeyProvider = { id: string; name: string; baseUrl: string | null; auth: { keySet: boolean } };
type Choice = { source: string; model: string | null; voice: string | null };
type Model = { model: string; displayName?: string | null; voices?: string[]; isDefault?: boolean };
type Mcp = { version: string | null; write: { available: boolean }; servers: { name: string; whispertype?: { backend: string | null; model: string | null; everyChat?: boolean; explicit?: boolean } }[] };
type Feature = "chat" | "speech" | "live" | "dictation";
type Pick = { model: string; voice: string | null };
type Draft = Pick & { provider: string; feature: Feature };

/** Masih, 6 Nov: "optionally one key for everything; remember? we get to check and uncheck." */
const FEATURES: [Feature, string][] = [["chat", "Chat"], ["speech", "Read aloud"], ["live", "Live voice"], ["dictation", "Dictation"]];
const DEFAULT_SPEECH: Choice = { source: "local", model: null, voice: null };

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

function readModels(value: { data: Model[] }): Model[] {
  if (!Array.isArray(value?.data) || !value.data.every(item => item && typeof item.model === "string" && (item.displayName == null || typeof item.displayName === "string") && (item.voices == null || (Array.isArray(item.voices) && item.voices.every(voice => typeof voice === "string"))))) throw Error("Invalid model choices.");
  return value.data;
}

function openrouter(provider: KeyProvider) {
  try { const url = new URL(provider.baseUrl ?? ""); return url.protocol === "https:" && url.hostname === "openrouter.ai" && url.pathname.replace(/\/+$/, "") === "/api/v1"; }
  catch { return false; }
}

/** A server on this computer answers without a key; every hosted service needs one. */
function onThisComputer(provider: KeyProvider) {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(provider.baseUrl ?? "").hostname); }
  catch { return false; }
}

const catalogRoute = (feature: Feature, id: string) => `/models?provider=${encodeURIComponent(id)}${feature === "chat" ? "" : `&outputModality=${feature === "speech" ? "speech" : "transcription"}`}`;

/** The checkboxes under each API key: a ticked feature uses that key. Every choice saves into its existing owner
 * (Configuration's main model, the read aloud preference, WhisperType), so one feature is on at most one key, and an
 * unticked feature returns to its default: ChatGPT for chat, local Kokoro for read aloud, Automatic for dictation. */
export function useKeyUses({ providers, refreshKey, active = true }: { providers: KeyProvider[]; refreshKey: number; active?: boolean }): (provider: KeyProvider) => ReactNode {
  const { data: settings, error: settingsError } = useElpisSettings();
  const [speech, setSpeech] = useState<Choice | null>(null);
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [failed, setFailed] = useState<{ speech?: boolean; dictation?: boolean }>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [catalogs, setCatalogs] = useState<Record<string, Model[] | "loading" | "failed">>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ provider: string; tone: "status" | "alert"; text: string } | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    setSpeech(null); setMcp(null); setFailed({}); setDraft(null);
    void api<Choice>("/read-aloud/settings").then(readChoice).then(value => { if (alive) setSpeech(value); }).catch(() => { if (alive) setFailed(old => ({ ...old, speech: true })); });
    void api<Mcp>("/mcp").then(readMcp).then(value => { if (alive) setMcp(value); }).catch(() => { if (alive) setFailed(old => ({ ...old, dictation: true })); });
    return () => { alive = false; };
  }, [active, refreshKey]);

  const server = mcp?.servers.find(item => item.name === "whispertype");
  const routers = providers.filter(openrouter);
  const saved = (provider: KeyProvider, feature: Feature): Pick | null => {
    if (feature === "chat") return settings && settings.main.provider === provider.id ? { model: settings.main.model ?? "", voice: null } : null;
    if (feature === "speech") return speech && speech.source === provider.id ? { model: speech.model ?? "", voice: speech.voice } : null;
    if (feature === "dictation") return server?.whispertype?.backend === "openrouter" && routers.length === 1 && routers[0].id === provider.id ? { model: server.whispertype.model ?? "", voice: null } : null;
    return null;
  };
  const drafted = (provider: KeyProvider, feature: Feature) => draft && draft.provider === provider.id && draft.feature === feature ? draft : null;
  const reason = (provider: KeyProvider, feature: Feature): string | null => {
    if (feature === "live") return "Live voice runs only on the ChatGPT subscription.";
    if (feature === "speech" && !openrouter(provider)) return "This provider has no speech models.";
    if (feature === "dictation" && !openrouter(provider)) return "This provider has no transcription models.";
    if (!provider.auth.keySet && !(feature === "chat" && onThisComputer(provider))) return "Add an API key first.";
    if (feature === "chat") {
      if (!settings) return settingsError ? "Chat settings unavailable." : "Reading chat settings…";
      if (!editable(settings)) return "Chat settings can't be saved here.";
      if (settings.managed?.modelProvider && settings.managed.modelProvider !== provider.id) return "Your requirements pin the chat provider.";
      return null;
    }
    if (feature === "speech") return failed.speech ? "Read aloud settings unavailable." : !speech ? "Reading read aloud settings…" : null;
    if (failed.dictation) return "Dictation settings unavailable.";
    if (!mcp) return "Reading dictation settings…";
    if (!server) return "Add WhisperType under Settings → MCP servers.";
    if (!mcp.write.available) return "Dictation settings can't be saved here.";
    if (routers.length > 1) return "Dictation works with one OpenRouter key; remove the others to use it.";
    return null;
  };

  // A ticked feature lists the key's models for it; each list is read once per refresh.
  const open = providers.flatMap(provider => FEATURES.filter(([feature]) => feature !== "live" && !reason(provider, feature) && (drafted(provider, feature) || saved(provider, feature))).map(([feature]) => `${refreshKey}|${feature}|${provider.id}`)).join(" ");
  useEffect(() => {
    if (!active || !open) return;
    let alive = true;
    for (const key of open.split(" ")) {
      if (catalogs[key]) continue;
      const [, feature, id] = key.split("|") as [string, Feature, string];
      setCatalogs(old => ({ ...old, [key]: "loading" }));
      void api<{ data: Model[] }>(catalogRoute(feature, id)).then(readModels).then(models => { if (alive) setCatalogs(old => ({ ...old, [key]: models })); })
        .catch(() => { if (alive) setCatalogs(old => ({ ...old, [key]: "failed" })); });
    }
    return () => { alive = false; };
  }, [active, open]);

  async function perform(provider: KeyProvider, action: () => Promise<string>) {
    if (busy) return; setBusy(true); setMessage(null);
    try { setMessage({ provider: provider.id, tone: "status", text: await action() }); }
    catch (cause) { setMessage({ provider: provider.id, tone: "alert", text: errorText(cause) }); }
    finally { setBusy(false); }
  }
  async function use(provider: KeyProvider, feature: Feature, label: string, pick: Pick) {
    await perform(provider, async () => {
      if (feature === "chat") await saveSettings("/settings", { version: settings?.version, main: { provider: provider.id, model: pick.model } });
      else if (feature === "speech") { setSpeech(readChoice(await api<Choice>("/read-aloud/settings", { source: provider.id, model: pick.model, voice: pick.voice }))); window.dispatchEvent(new Event("elpis-read-aloud-settings")); }
      else setMcp(readMcp(await api<Mcp>("/mcp", { version: mcp?.version, name: "whispertype", action: "whispertype", backend: "openrouter", model: pick.model, everyChat: true })));
      setDraft(null);
      return `${label} now uses ${provider.name}. Paid per use.`;
    });
  }
  async function release(provider: KeyProvider, feature: Feature, label: string) {
    await perform(provider, async () => {
      if (feature === "chat") {
        const models = readModels(await api<{ data: Model[] }>("/models?provider=openai").catch(() => ({ data: [] })));
        const fallback = models.find(item => item.isDefault) ?? models[0];
        if (!fallback) throw Error("Sign in with ChatGPT first: chat has no default model to return to.");
        await saveSettings("/settings", { version: settings?.version, main: { provider: "openai", model: fallback.model } });
        return `Chat is back on ChatGPT (${fallback.displayName || fallback.model}).`;
      }
      if (feature === "speech") { setSpeech(readChoice(await api<Choice>("/read-aloud/settings", DEFAULT_SPEECH))); window.dispatchEvent(new Event("elpis-read-aloud-settings")); return "Read aloud is back on local Kokoro."; }
      setMcp(readMcp(await api<Mcp>("/mcp", { version: mcp?.version, name: "whispertype", action: "whispertype", backend: null, everyChat: false })));
      return `${label} is back on Automatic (Settings → Voice).`;
    });
  }
  function toggle(provider: KeyProvider, feature: Feature, label: string, checked: boolean) {
    if (busy || reason(provider, feature)) return;
    setMessage(null);
    if (checked) { if (!saved(provider, feature)) setDraft({ provider: provider.id, feature, model: "", voice: null }); return; }
    if (drafted(provider, feature) && !saved(provider, feature)) { setDraft(null); return; }
    void release(provider, feature, label);
  }

  return function KeyUses(provider: KeyProvider) {
    return <fieldset className="key-uses" aria-label={`Use ${provider.name} for`}>
      <legend className="key-uses-title">Use this key for</legend>
      {FEATURES.map(([feature, label]) => {
        const why = reason(provider, feature), current = saved(provider, feature), pending = drafted(provider, feature);
        const pick = pending ?? current, checked = !why && !!pick;
        const holder = pending && !current ? providers.find(item => item.id !== provider.id && saved(item, feature)) : undefined;
        const catalog = catalogs[`${refreshKey}|${feature}|${provider.id}`];
        const models = Array.isArray(catalog) ? catalog : [];
        const chosen = models.find(item => item.model === pick?.model);
        const voices = feature === "speech" ? chosen?.voices ?? [] : [];
        const ready = !!pending && !!pending.model && !(feature === "speech" && (!chosen || speechModelUnavailable(pending.model) || (voices.length > 0 && !pending.voice)));
        const edit = (change: Partial<Pick>) => setDraft({ provider: provider.id, feature, model: pick?.model ?? "", voice: pick?.voice ?? null, ...change });
        return <div key={feature} className="key-use" data-feature={feature}>
          <label className="key-use-label"><Checkbox aria-label={`Use ${provider.name} for ${label}`} checked={checked} disabled={!!why || busy} onCheckedChange={(value: boolean) => toggle(provider, feature, label, value)} />{label}</label>
          {why && <span className="key-use-note">{why}</span>}
          {checked && pick && <>
            <OptionSelect aria-label={`${label} model for ${provider.name}`} className="settings-choice" value={pick.model} disabled={busy || catalog === "failed"} onChange={event => edit({ model: event.target.value, voice: null })}>
              <option value="" disabled>{catalog === "loading" ? "Reading models…" : "Choose model"}</option>
              {pick.model && !models.some(item => item.model === pick.model) && <option value={pick.model}>{pick.model}</option>}
              {models.map(item => { const blocked = feature === "speech" ? speechModelUnavailable(item.model) : null; return <option key={item.model} value={item.model} disabled={!!blocked} data-hint={blocked ?? undefined}>{item.displayName || item.model}</option>; })}
            </OptionSelect>
            {voices.length > 0 && <OptionSelect aria-label={`${label} voice for ${provider.name}`} className="settings-choice" value={pick.voice ?? ""} disabled={busy} onChange={event => edit({ voice: event.target.value || null })}>
              <option value="" disabled>Choose voice</option>{voices.map(voice => <option key={voice} value={voice}>{voice}</option>)}
            </OptionSelect>}
            {pending && <Button variant="outline" aria-label={`Save ${label} for ${provider.name}`} disabled={busy || !ready} onClick={() => void use(provider, feature, label, pending)}>Save</Button>}
            {holder && <span className="key-use-note">{`Moves ${label} from ${holder.name}.`}</span>}
            {catalog === "failed" && <span className="key-use-note">{`${label} model choices unavailable.`}</span>}
          </>}
        </div>;
      })}
      {message?.provider === provider.id && <SettingsNotice tone={message.tone}>{message.text}</SettingsNotice>}
    </fieldset>;
  };
}
