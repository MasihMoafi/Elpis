"use client";

import { useEffect, useRef, useState } from "react";
import { api, modelLabel, providerLabel, subscriptionOf, type Model } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { SaveFeedback, SettingRow, SettingsActions, SettingsGroup, SettingsNotice } from "@/components/settings/rows";
import { useSaver } from "@/components/settings/use-saver";
import { editable, reloadSettings, saveSettings, type Background, type ElpisSettings, type Memory } from "@/lib/settings-store";

// Background model, Smart Prune and memory settings (formerly the "Elpis" page), each saved
// through the bridge's versioned config writer.
const shown = (value: string | boolean | null | undefined) => typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : value || "Not reported";
const reloaded = { ok: true, text: "Settings reloaded. Unsaved edits were discarded." };

export function useModelCatalog() {
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    api<{ data: Model[] }>("/models").then(value => { if (!Array.isArray(value?.data)) throw new Error("Model catalog response did not contain models."); if (!disposed) setModels(value.data); })
      .catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, []);
  return { models, error };
}

/** Model lists by configured connection; another connection's catalog is read from its own endpoint. */
function useProviderCatalogs(value: ElpisSettings, models: Model[], selected: (string | null)[]) {
  const mainModels = models.filter(model => !subscriptionOf(model.model));
  const [catalogs, setCatalogs] = useState<Record<string, { version: string | null | undefined; models: Model[]; loading?: boolean; error?: string }>>({});
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const catalogFor = (provider: string) => catalogs[provider]?.version === value.version ? catalogs[provider] : undefined;
  const wanted = selected.join("\n");
  useEffect(() => {
    const version = value.version;
    for (const provider of new Set(wanted.split("\n"))) {
      if (!provider || provider === value.main.provider || catalogFor(provider) || !value.providers?.some(item => item.id === provider)) continue;
      setCatalogs(old => ({ ...old, [provider]: { version, models: [], loading: true } }));
      api<{ data: Model[] }>("/models?provider=" + encodeURIComponent(provider)).then(result => {
        if (!Array.isArray(result?.data)) throw new Error("Model catalog response did not contain models.");
        if (active.current) setCatalogs(old => old[provider]?.version === version ? { ...old, [provider]: { version, models: result.data } } : old);
      }).catch(error => {
        if (active.current) setCatalogs(old => old[provider]?.version === version ? { ...old, [provider]: { version, models: [], error: error instanceof Error ? error.message : String(error) } } : old);
      });
    }
  }, [wanted, value.main.provider, value.providers, value.version, catalogs]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    mainModels,
    forProvider: (provider: string | null) => !provider || provider === value.main.provider ? mainModels : catalogFor(provider)?.models ?? [],
    connectionLabel: (provider: string | null) => providerLabel(null, provider ?? value.main.provider, value.providers) || "the conversation provider",
    catalogStatus: (provider: string | null) => { const catalog = provider ? catalogFor(provider) : undefined; return catalog?.loading ? "Loading model choices…" : catalog?.error ? "Model choices could not be loaded: " + catalog.error : undefined; },
  };
}

function ModelChoice({ label, value, models, provider, catalogStatus, disabled, inheritLabel, onChange }: {
  label: string; value: string | null; models: Model[]; provider: string; catalogStatus?: string; disabled: boolean; inheritLabel: string; onChange: (value: string | null) => void;
}) {
  if (models.length) return <OptionSelect aria-label={label} className="settings-choice" value={value ?? ""} onChange={event => onChange(event.target.value || null)} disabled={disabled}>
    <option value="">{inheritLabel}</option>
    {value && !models.some(model => model.model === value) && <option value={value}>Current configured model</option>}
    {models.map(model => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}
  </OptionSelect>;
  return <div className="grid min-w-0 gap-1 text-sm">
    <span className="text-muted-foreground">{value ? "Current configured model" : inheritLabel}</span>
    {catalogStatus && <span role="status" className="text-xs text-muted-foreground">{catalogStatus}</span>}
    <details><summary className="cursor-pointer">Advanced: custom model</summary><p className="text-xs text-muted-foreground">No model catalog is available for {provider}.</p>
      <Input aria-label={label} value={value ?? ""} onChange={event => onChange(event.target.value.trim() || null)} placeholder="Model name supplied by this connection" maxLength={200} disabled={disabled} />
    </details>
  </div>;
}

function providerOptions(current: string, providers: ElpisSettings["providers"] = []) {
  return <>{current && !providers.some(item => item.id === current) && <option value={current}>{current}</option>}{providers.map(item => <option key={item.id} value={item.id}>{providerLabel(null, item.id, providers)}</option>)}</>;
}

/** Main model (read-only here) and the background model Smart Prune falls back to. */
export function BackgroundSettings({ value, models }: { value: ElpisSettings; models: Model[] }) {
  const [draft, setDraft] = useState<Partial<Background>>({});
  const saver = useSaver();
  const current = { ...value.background, ...draft };
  const catalogs = useProviderCatalogs(value, models, [current.provider]);
  const changed = Object.keys(draft).length > 0;
  const update = (key: keyof Background, text: string | null) => {
    const next = text?.trim() || null; saver.clear();
    setDraft(old => { const patch = { ...old }; if (next === value.background[key]) delete patch[key]; else patch[key] = next; return patch; });
  };
  const reload = () => void saver.run("reload", async () => { await reloadSettings(); setDraft({}); }, reloaded.text);
  return <SettingsGroup title="Models" description="Background settings apply to new conversations.">
    <SettingRow title="Main model" description="New chats start with this model. Change it per chat in the composer.">
      <span className="text-sm">{value.main.model ? modelLabel(value.main.model, models) : "Not reported"}<span className="text-muted-foreground"> · {providerLabel(value.main.model, value.main.provider, value.providers) || "Not reported"}</span></span>
    </SettingRow>
    {editable(value) ? <>
      <SettingRow title="Background model" description="Smart Prune falls back to this model.">
        <ModelChoice label="Background model" value={current.model} models={catalogs.forProvider(current.provider)} provider={catalogs.connectionLabel(current.provider)} catalogStatus={catalogs.catalogStatus(current.provider)} disabled={saver.pending !== null} inheritLabel="Default background model" onChange={model => update("model", model)} />
      </SettingRow>
      <SettingRow title="Background provider" description="The connection the background model runs on.">
        <OptionSelect aria-label="Background provider" className="settings-choice" value={current.provider ?? ""} onChange={event => update("provider", event.target.value)} disabled={saver.pending !== null}><option value="">Use default</option>{providerOptions(draft.provider ?? value.background.provider ?? "", value.providers)}</OptionSelect>
      </SettingRow>
      <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={reload} />}>
        <Button size="sm" disabled={saver.pending !== null || !changed} onClick={() => void saver.run("save", async () => { await saveSettings("/settings", { version: value.version, background: draft }); setDraft({}); }, "Background model saved. Applies to new conversations.")}>{saver.pending === "save" ? "Saving…" : "Save background model"}</Button>
      </SettingsActions>
    </> : <>
      <SettingRow title="Background model"><span className="text-sm">{shown(value.background.model)}</span></SettingRow>
      <SettingRow title="Background provider" description={value.write.reason}><span className="text-sm">{shown(value.background.provider)}</span></SettingRow>
    </>}
  </SettingsGroup>;
}

/** Smart Prune: whether it is on, and which model prunes. */
export function PrunerSettings({ value, models }: { value: ElpisSettings; models: Model[] }) {
  const override = value.smartPrune.explicitOverride;
  const saved = { mode: override.model ? "explicit" as const : "background" as const, model: override.model ?? "", provider: override.provider ?? "" };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const saver = useSaver();
  const current = draft ?? saved;
  const catalogs = useProviderCatalogs(value, models, [current.mode === "explicit" ? current.provider : null]);
  const changed = current.mode !== saved.mode || (current.mode === "explicit" && (current.model.trim() !== saved.model || current.provider !== saved.provider));
  const update = (patch: Partial<typeof saved>) => { setDraft({ ...current, ...patch }); saver.clear(); };
  const reload = () => void saver.run("reload", async () => { await reloadSettings(); setDraft(null); }, reloaded.text);
  const editableOverride = override.available === true && typeof override.version === "string";
  return <SettingsGroup title="Smart Prune" description="Optimizes fresh tool results before the main model reads them.">
    <SettingRow title="Automatic pruning" description={<>Saved as <code className="settings-code">features.automatic_context_pruning</code>; off unless turned on. Applies to new conversations.</>}>
      {editable(value) ? <Switch aria-label="Automatic pruning" checked={value.smartPrune.enabled ?? false} disabled={saver.pending !== null}
        onCheckedChange={next => void saver.run("pruning", () => saveSettings("/settings", { version: value.version, options: { automaticPruning: next } }), next ? "Smart Prune on. Applies to new conversations." : "Smart Prune off. Applies to new conversations.")} />
        : <span className="text-sm">{shown(value.smartPrune.enabled ?? false)}</span>}
    </SettingRow>
    {editableOverride ? <>
      <SettingRow title="Pruning model selection" description="Applies to the next pruning attempt.">
        <OptionSelect aria-label="Pruning model selection" className="settings-choice" value={current.mode} onChange={event => update({ mode: event.target.value as "background" | "explicit" })} disabled={saver.pending !== null}><option value="background">Use background model</option><option value="explicit">Choose model and provider</option></OptionSelect>
      </SettingRow>
      {current.mode === "explicit" && <>
        <SettingRow title="Pruning provider"><OptionSelect aria-label="Pruning provider" className="settings-choice" value={current.provider} onChange={event => update({ provider: event.target.value })} disabled={saver.pending !== null}><option value="" disabled>Select provider</option>{providerOptions(current.provider, value.providers)}</OptionSelect></SettingRow>
        <SettingRow title="Pruning model" description="Choose a model supported by the selected provider."><ModelChoice label="Pruning model" value={current.model || null} models={catalogs.forProvider(current.provider || null)} provider={catalogs.connectionLabel(current.provider || null)} catalogStatus={catalogs.catalogStatus(current.provider || null)} disabled={saver.pending !== null} inheritLabel="Choose a pruning model" onChange={model => update({ model: model ?? "" })} /></SettingRow>
      </>}
      <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={reload} />}>
        <Button size="sm" disabled={saver.pending !== null || !changed || (current.mode === "explicit" && (!current.model.trim() || !current.provider))} onClick={() => void saver.run("save", async () => { await saveSettings("/pruner", { version: override.version, model: current.mode === "explicit" ? current.model.trim() : null, provider: current.mode === "explicit" ? current.provider : null }); setDraft(null); }, "Pruning model saved. Applies to the next pruning attempt.")}>{saver.pending === "save" ? "Saving…" : "Save pruning model"}</Button>
      </SettingsActions>
    </> : <SettingRow title="Pruning model" description={override.reason ?? "Pruning model settings are unavailable."} />}
  </SettingsGroup>;
}

const SWITCHES: { key: "enabled" | "generate" | "use" | "allowExternal"; title: string; description: string }[] = [
  { key: "enabled", title: "Enable memories", description: "Let Elpis keep memories from chats and use them to personalize later chats." },
  { key: "generate", title: "Generate memories", description: "Create memories from new chats." },
  { key: "use", title: "Use memories", description: "Give new chats the memories Elpis has saved." },
  { key: "allowExternal", title: "Allow memories from tool-assisted chats", description: "Generate memories from chats that used MCP tools or web search." },
];
// Unset values follow Elpis's defaults: memories off; generate, use and tool-assisted chats on.
function switchValue(memory: Memory, key: (typeof SWITCHES)[number]["key"]) {
  if (key === "enabled") return memory.enabled ?? false;
  if (key === "allowExternal") return !(memory.skipExternalContext ?? false);
  return memory[key] ?? true;
}

/** Memories: switches apply at once; model choices are saved together; deleting asks first. */
export function MemorySettings({ value, models }: { value: ElpisSettings; models: Model[] }) {
  const [draft, setDraft] = useState<Partial<Pick<Memory, "extractionModel" | "consolidationModel">>>({});
  const [confirming, setConfirming] = useState(false);
  const saver = useSaver();
  const catalogs = useProviderCatalogs(value, models, []);
  const memory = { ...value.memory, ...draft };
  const changed = Object.keys(draft).length > 0;
  const reload = () => void saver.run("reload", async () => { await reloadSettings(); setDraft({}); }, reloaded.text);
  const toggle = (key: (typeof SWITCHES)[number]["key"], next: boolean) => void saver.run(key, () => saveSettings("/settings", { version: value.version, memory: key === "allowExternal" ? { skipExternalContext: !next } : { [key]: next } }), "Saved. Applies to new conversations.");
  if (!editable(value)) return <SettingsGroup title="Memories">
    <SettingRow title="Enable memories"><span className="text-sm">{shown(value.memory.enabled ?? null)}</span></SettingRow>
    <SettingRow title="Generate memories"><span className="text-sm">{shown(value.memory.generate)}</span></SettingRow>
    <SettingRow title="Use memories"><span className="text-sm">{shown(value.memory.use)}</span></SettingRow>
    <SettingRow title="Extraction model"><span className="text-sm">{shown(value.memory.extractionModel)}</span></SettingRow>
    <SettingRow title="Consolidation model" description={value.write.reason}><span className="text-sm">{shown(value.memory.consolidationModel)}</span></SettingRow>
  </SettingsGroup>;
  return <SettingsGroup title="Memories" description={`Memory models use their conversation’s provider. Default provider: ${catalogs.connectionLabel(value.main.provider)}.`}>
    {SWITCHES.map(item => <SettingRow key={item.key} title={item.title} description={item.description}>
      <Switch aria-label={item.title} checked={switchValue(value.memory, item.key)} disabled={saver.pending !== null} onCheckedChange={next => toggle(item.key, next)} />
    </SettingRow>)}
    {(["extractionModel", "consolidationModel"] as const).map(key => <SettingRow key={key} title={key === "extractionModel" ? "Memory extraction model" : "Memory consolidation model"} description={key === "extractionModel" ? "Summarizes each chat into memories." : "Merges memories into the saved set."}>
      <ModelChoice label={key === "extractionModel" ? "Memory extraction model" : "Memory consolidation model"} value={memory[key]} models={catalogs.mainModels} provider={catalogs.connectionLabel(value.main.provider)} disabled={saver.pending !== null} inheritLabel="Default conversation model"
        onChange={model => { saver.clear(); setDraft(old => { const patch = { ...old }; if (model === value.memory[key]) delete patch[key]; else patch[key] = model; return patch; }); }} />
    </SettingRow>)}
    <SettingRow title="Delete memories" description="Remove every memory Elpis has saved. Chats are not deleted.">
      <Button variant="destructive" size="sm" disabled={saver.pending !== null} onClick={() => setConfirming(true)}>Delete</Button>
    </SettingRow>
    <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={reload} />}>
      <Button size="sm" disabled={saver.pending !== null || !changed} onClick={() => void saver.run("models", async () => { await saveSettings("/settings", { version: value.version, memory: draft }); setDraft({}); }, "Memory models saved. Applies to new conversations.")}>{saver.pending === "models" ? "Saving…" : "Save memory models"}</Button>
    </SettingsActions>
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete all memories?</AlertDialogTitle>
          <AlertDialogDescription>Elpis removes its saved memories and their files. This cannot be undone.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={() => { setConfirming(false); void saver.run("reset", () => api("/memories/reset", {}), "Memories deleted."); }}>Delete memories</Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsGroup>;
}

export function CatalogNotice({ error }: { error: string }) {
  return error ? <SettingsNotice>Model choices could not be loaded: {error}</SettingsNotice> : null;
}
