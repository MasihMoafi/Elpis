"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { useEffect, useRef, useState } from "react";
import { api, connectionOrder, effortsOf, isListedProvider, modelLabel, providerLabel, subscriptionOf, type Model } from "@/lib/api";
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

export function ModelChoice({ label, value, models, provider, catalogStatus, disabled, inheritLabel, onChange }: {
  label: string; value: string | null; models: Model[]; provider: string; catalogStatus?: string; disabled: boolean; inheritLabel?: string; onChange: (value: string | null) => void;
}) {
  return <div role="group" aria-label={`${label} choices`} className="settings-field-stack text-sm">
    {models.length ? <OptionSelect aria-label={label} className="settings-choice" value={value ?? ""} onChange={event => onChange(event.target.value || null)} disabled={disabled}>
    {inheritLabel ? <option value="">{inheritLabel}</option> : !value && <option value="" disabled>Choose a model</option>}
    {value && !models.some(model => model.model === value) && <option value={value}>Current configured model</option>}
    {models.map(model => <option key={model.model} value={model.model}>{model.displayName || model.model}</option>)}
    </OptionSelect> : <span className="text-muted-foreground">{value ? "Current configured model" : inheritLabel ?? "No model chosen"}</span>}
    {catalogStatus && <span role="status" className="text-xs text-muted-foreground">{catalogStatus}</span>}
    <details><DisclosureSummary className="cursor-pointer">Advanced: custom model</DisclosureSummary><p className="text-xs text-muted-foreground">{models.length ? `Enter a model ID supported by ${provider}.` : `No model catalog is available for ${provider}.`}</p>
      <Input aria-label={models.length ? `Custom ${label}` : label} value={value ?? ""} onChange={event => onChange(event.target.value.trim() || null)} placeholder="Model name supplied by this connection" maxLength={200} disabled={disabled} />
    </details>
  </div>;
}

function providerOptions(current: string, providers: ElpisSettings["providers"] = []) {
  const listed = providers.filter(item => item.id === current || isListedProvider(item.id)).map(item => ({ id: item.id, label: providerLabel(null, item.id, providers) }));
  return <>{current && !providers.some(item => item.id === current) && <option value={current}>{current}</option>}{connectionOrder(listed).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</>;
}

/** The main model (what new chats start with, here and in the TUI) and the background model Smart Prune falls back to. */
export function ModelSettings({ value, models }: { value: ElpisSettings; models: Model[] }) {
  return <SettingsGroup title="Models" description="Saved in Elpis's config.toml, shared with the TUI; they apply to new conversations.">
    <ModelPair which="main" value={value} models={models} />
    <ModelPair which="background" value={value} models={models} />
  </SettingsGroup>;
}

const PAIRS = {
  main: { name: "Main", model: "New chats start with this model, here and in the TUI. Change it per chat in the composer.", provider: "The connection the main model runs on." },
  background: { name: "Background", model: "Smart Prune falls back to this model.", provider: "The connection the background model runs on." },
};
/** One model and the provider it runs on, saved together. The main model can't be cleared; the background one can. */
function ModelPair({ which, value, models }: { which: keyof typeof PAIRS; value: ElpisSettings; models: Model[] }) {
  const [draft, setDraft] = useState<Partial<Background>>({});
  const saver = useSaver();
  const saved = value[which], current = { ...saved, ...draft }, { name } = PAIRS[which];
  const title = `${name} model`;
  const catalogs = useProviderCatalogs(value, models, [current.provider]);
  const pinned = which === "main" && value.managed?.modelProvider ? value.managed.modelProvider : null;
  const update = (key: keyof Background, text: string | null) => {
    const next = text?.trim() || null; saver.clear();
    setDraft(old => { const patch = { ...old }; if (next === saved[key]) delete patch[key]; else patch[key] = next; return patch; });
  };
  const reload = () => void saver.run("reload", async () => { await reloadSettings(); setDraft({}); }, reloaded.text);
  if (!editable(value)) return <>
    <SettingRow title={title}><span className="text-sm">{which === "main" && saved.model ? modelLabel(saved.model, models) : shown(saved.model)}</span></SettingRow>
    <SettingRow title={`${name} provider`} description={value.write.reason}><span className="text-sm">{shown(saved.provider)}</span></SettingRow>
  </>;
  return <>
    <SettingRow title={title} description={PAIRS[which].model}>
      <ModelChoice label={title} value={current.model} models={catalogs.forProvider(current.provider)} provider={catalogs.connectionLabel(current.provider)} catalogStatus={catalogs.catalogStatus(current.provider)} disabled={saver.pending !== null} inheritLabel={which === "main" ? undefined : "Default background model"} onChange={model => update("model", model)} />
    </SettingRow>
    <SettingRow title={`${name} provider`} description={pinned ? "Pinned by your requirements." : PAIRS[which].provider}>
      <OptionSelect aria-label={`${name} provider`} className="settings-choice" value={current.provider ?? ""} onChange={event => update("provider", event.target.value)} disabled={saver.pending !== null || Boolean(pinned)}><option value="">Use default</option>{providerOptions(draft.provider ?? saved.provider ?? "", value.providers)}</OptionSelect>
    </SettingRow>
    <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={reload} />}>
      <Button disabled={saver.pending !== null || !Object.keys(draft).length || (which === "main" && !current.model)} onClick={() => void saver.run("save", async () => { await saveSettings("/settings", { version: value.version, [which]: draft }); setDraft({}); }, `${name} model saved. Applies to new conversations.`)}>{saver.pending === "save" ? "Saving…" : `Save ${name.toLowerCase()} model`}</Button>
    </SettingsActions>
  </>;
}

/** Smart Prune: whether it is on, and which model and effort prune. */
export function PrunerSettings({ value, models }: { value: ElpisSettings; models: Model[] }) {
  const override = value.smartPrune.explicitOverride;
  const saved = { mode: override.model ? "explicit" as const : "background" as const, model: override.model ?? "", provider: override.provider ?? "", reasoningEffort: override.reasoningEffort ?? "" };
  const [draft, setDraft] = useState<typeof saved | null>(null);
  const saver = useSaver();
  const current = draft ?? saved;
  const providerFor = (choice: typeof saved) => choice.mode === "explicit" ? choice.provider : value.background.provider ?? value.main.provider;
  const catalogs = useProviderCatalogs(value, models, [providerFor(current)]);
  const effortsFor = (choice: typeof saved) => effortsOf(choice.mode === "explicit" ? choice.model : value.background.model ?? value.main.model, catalogs.forProvider(providerFor(choice)));
  const efforts = effortsFor(current);
  const validEffort = !current.reasoningEffort || efforts.includes(current.reasoningEffort);
  const changed = current.reasoningEffort !== saved.reasoningEffort || current.mode !== saved.mode || (current.mode === "explicit" && (current.model.trim() !== saved.model || current.provider !== saved.provider));
  const update = (patch: Partial<typeof saved>) => {
    const next = { ...current, ...patch };
    if ((next.mode !== current.mode || next.model !== current.model || next.provider !== current.provider) && !effortsFor(next).includes(next.reasoningEffort)) next.reasoningEffort = "";
    setDraft(next); saver.clear();
  };
  const reload = () => void saver.run("reload", async () => { await reloadSettings(); setDraft(null); }, reloaded.text);
  const editableOverride = override.available === true && typeof override.version === "string";
  return <SettingsGroup title="Smart Prune" description="Optimizes fresh tool results before the main model reads them.">
    <SettingRow title="Automatic pruning" description={<>Saved as <code className="settings-code">features.automatic_context_pruning</code>; off unless turned on. Applies to new conversations.</>}>
      {editable(value) ? <Switch aria-label="Automatic pruning" checked={value.smartPrune.enabled ?? false} disabled={saver.pending !== null}
        onCheckedChange={next => void saver.run("pruning", () => saveSettings("/settings", { version: value.version, options: { automaticPruning: next } }), next ? "Smart Prune on. Applies to new conversations." : "Smart Prune off. Applies to new conversations.")} />
        : <span className="text-sm">{shown(value.smartPrune.enabled ?? false)}</span>}
    </SettingRow>
    {editableOverride ? <>
      <SettingRow title="Pruning model selection" scope="this device" description="Applies to the next pruning attempt.">
        <OptionSelect aria-label="Pruning model selection" className="settings-choice" value={current.mode} onChange={event => update({ mode: event.target.value as "background" | "explicit" })} disabled={saver.pending !== null}><option value="background">Use background model</option><option value="explicit">Choose model and provider</option></OptionSelect>
      </SettingRow>
      {current.mode === "explicit" && <>
        <SettingRow title="Pruning provider" scope="this device"><OptionSelect aria-label="Pruning provider" className="settings-choice" value={current.provider} onChange={event => update({ provider: event.target.value })} disabled={saver.pending !== null}><option value="" disabled>Select provider</option>{providerOptions(current.provider, value.providers)}</OptionSelect></SettingRow>
        <SettingRow title="Pruning model" scope="this device" description="Choose a model supported by the selected provider."><ModelChoice label="Pruning model" value={current.model || null} models={catalogs.forProvider(current.provider || null)} provider={catalogs.connectionLabel(current.provider || null)} catalogStatus={catalogs.catalogStatus(current.provider || null)} disabled={saver.pending !== null} inheritLabel="Choose a pruning model" onChange={model => update({ model: model ?? "" })} /></SettingRow>
      </>}
      <SettingRow title="Pruning effort" scope="this device" description={validEffort ? "Default uses Low. Applies to the next pruning attempt." : "The saved effort is unavailable for this model. Choose Default or a supported effort."}>
        <OptionSelect aria-label="Pruning effort" className="settings-choice" value={current.reasoningEffort} onChange={event => update({ reasoningEffort: event.target.value })} disabled={saver.pending !== null}>
          <option value="">Default (Low)</option>
          {efforts.map(effort => <option key={effort} value={effort}>{effort.charAt(0).toUpperCase() + effort.slice(1)}</option>)}
        </OptionSelect>
      </SettingRow>
      <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={reload} />}>
        <Button disabled={saver.pending !== null || !changed || !validEffort || (current.mode === "explicit" && (!current.model.trim() || !current.provider))} onClick={() => void saver.run("save", async () => { await saveSettings("/pruner", { version: override.version, model: current.mode === "explicit" ? current.model.trim() : null, provider: current.mode === "explicit" ? current.provider : null, reasoningEffort: current.reasoningEffort || null }); setDraft(null); }, "Pruning model saved. Applies to the next pruning attempt.")}>{saver.pending === "save" ? "Saving…" : "Save pruning model"}</Button>
      </SettingsActions>
    </> : <SettingRow title="Pruning model" description={override.reason ?? "Pruning model settings are unavailable."} />}
  </SettingsGroup>;
}

const SWITCHES: { key: "enabled" | "generate" | "use" | "allowExternal"; title: string; description: string }[] = [
  { key: "enabled", title: "Memories", description: "Let Elpis keep memories from chats and use them to personalize later chats. Off: nothing is saved or used." },
  { key: "generate", title: "Generate memories", description: "Create memories from new chats." },
  { key: "use", title: "Use memories", description: "Give new chats the memories Elpis has saved." },
  { key: "allowExternal", title: "Allow memories from tool-assisted chats", description: "Generate memories from chats that used MCP tools or web search." },
];
// Unset values follow Elpis's defaults: memories off; generate, use and tool-assisted chats on once memories are on.
// Memories is the master switch: while it is off the other options are not shown, so no page says "on" for what is off.
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
  const on = switchValue(value.memory, "enabled");
  if (!editable(value)) return <SettingsGroup title="Memories">
    <SettingRow title="Memories" description={value.memory.enabled === false ? value.write.reason : undefined}><span className="text-sm">{shown(value.memory.enabled ?? null)}</span></SettingRow>
    {value.memory.enabled !== false && <>
      <SettingRow title="Generate memories"><span className="text-sm">{shown(value.memory.generate)}</span></SettingRow>
      <SettingRow title="Use memories"><span className="text-sm">{shown(value.memory.use)}</span></SettingRow>
      <SettingRow title="Extraction model"><span className="text-sm">{shown(value.memory.extractionModel)}</span></SettingRow>
      <SettingRow title="Consolidation model" description={value.write.reason}><span className="text-sm">{shown(value.memory.consolidationModel)}</span></SettingRow>
    </>}
  </SettingsGroup>;
  return <SettingsGroup title="Memories" description={`Memory models use their conversation’s provider. Default provider: ${catalogs.connectionLabel(value.main.provider)}.`}>
    {SWITCHES.filter(item => item.key === "enabled" || on).map(item => <SettingRow key={item.key} title={item.title} description={item.description}>
      <Switch aria-label={item.title} checked={switchValue(value.memory, item.key)} disabled={saver.pending !== null} onCheckedChange={next => toggle(item.key, next)} />
    </SettingRow>)}
    {on && (["extractionModel", "consolidationModel"] as const).map(key => <SettingRow key={key} title={key === "extractionModel" ? "Memory extraction model" : "Memory consolidation model"} description={key === "extractionModel" ? "Summarizes each chat into memories." : "Merges memories into the saved set."}>
      <ModelChoice label={key === "extractionModel" ? "Memory extraction model" : "Memory consolidation model"} value={memory[key]} models={catalogs.mainModels} provider={catalogs.connectionLabel(value.main.provider)} disabled={saver.pending !== null} inheritLabel="Default conversation model"
        onChange={model => { saver.clear(); setDraft(old => { const patch = { ...old }; if (model === value.memory[key]) delete patch[key]; else patch[key] = model; return patch; }); }} />
    </SettingRow>)}
    <SettingRow title="Delete memories" description="Remove every memory Elpis has saved. Chats are not deleted.">
      <Button variant="destructive" disabled={saver.pending !== null} onClick={() => setConfirming(true)}>Delete</Button>
    </SettingRow>
    <SettingsActions feedback={<SaveFeedback outcome={saver.outcome} onReload={reload} />}>
      <Button disabled={saver.pending !== null || !changed} onClick={() => void saver.run("models", async () => { await saveSettings("/settings", { version: value.version, memory: draft }); setDraft({}); }, "Memory models saved. Applies to new conversations.")}>{saver.pending === "models" ? "Saving…" : "Save memory models"}</Button>
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
