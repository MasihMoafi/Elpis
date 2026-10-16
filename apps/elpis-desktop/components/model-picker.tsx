"use client";
import { useEffect, useState } from "react";
import { Tabs } from "@base-ui/react/tabs";
import { ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { OptionSelect } from "@/components/ui/option-select";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList, ComboboxTrigger } from "@/components/ui/combobox";
import { api, modelLabel, subscriptionOf, type ProviderChoice, type Model } from "@/lib/api";
type Choice = { key: string; model: string; choiceId: string; label: string; providerLabel: string; description?: string };

/** Cloudroom's searchable model/provider pattern, backed by Elpis's own catalog. */
export function ModelPicker({ choices, models, model, choiceId, defaultModel, disabled, allowCustom = true, onChange, onConfigure }: {
  choices: ProviderChoice[]; models: Model[]; model: string; choiceId: string; defaultModel?: string | null; disabled: boolean; allowCustom?: boolean;
  onChange: (choice: { model: string; choiceId: string }) => void; onConfigure?: () => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [tab, setTab] = useState("all");
  const [customProvider, setCustomProvider] = useState(""), [customModel, setCustomModel] = useState("");
  const [catalogs, setCatalogs] = useState<Record<string, { version: string; data: Model[]; loaded: boolean; loading: boolean; error: string }>>({});
  const [retry, setRetry] = useState(0);
  const activeConnection = choices.find(choice => choice.id === tab);
  const catalogFor = (choice?: ProviderChoice) => {
    const cached = choice ? catalogs[choice.id] : undefined;
    return cached?.version === (choice?.catalogVersion ?? "") ? cached : undefined;
  };
  const catalog = catalogFor(activeConnection);
  useEffect(() => {
    if (!open || disabled || !activeConnection?.provider || catalog?.loaded) return;
    let disposed = false;
    const { id, provider } = activeConnection;
    const version = activeConnection.catalogVersion ?? "";
    setCatalogs(previous => ({ ...previous, [id]: { version, data: [], loaded: false, loading: true, error: "" } }));
    api<{ data: Model[] }>(`/models?provider=${encodeURIComponent(provider)}`)
      .then(result => {
        if (!Array.isArray(result.data)) throw new Error("This connection returned an invalid model list.");
        if (!disposed) setCatalogs(previous => ({ ...previous, [id]: { version, data: result.data, loaded: true, loading: false, error: "" } }));
      })
      .catch(cause => { if (!disposed) setCatalogs(previous => ({ ...previous, [id]: { version, data: [], loaded: false, loading: false, error: cause instanceof Error ? cause.message : String(cause) } })); });
    return () => { disposed = true; };
  }, [open, disabled, activeConnection?.id, activeConnection?.provider, activeConnection?.catalogVersion, retry]); // Reuse successful catalogs only for the same saved configuration.
  const available: Choice[] = [...new Map(choices.flatMap(choice => (catalogFor(choice)?.data ?? choice.models).map(item => ({ key: `${choice.id}:${item.model}`, model: item.model, choiceId: choice.id, label: item.displayName || item.model, providerLabel: choice.label, description: item.description }))).map(item => [item.key, item])).values()];
  const currentModel = model || defaultModel || "";
  const current = available.find(item => item.model === currentModel && item.choiceId === choiceId) ?? null;
  const connection = choices.find(choice => choice.id === choiceId);
  const currentLabel = current?.label || modelLabel(currentModel, models);
  const currentProvider = current?.providerLabel || subscriptionOf(currentModel)?.label || connection?.label;
  const rows = tab === "all" ? available : available.filter(item => item.choiceId === tab);
  const groups = choices;
  const configured = choices.filter(choice => !!choice.provider);
  const choose = (choice: { model: string; choiceId: string }) => { onChange(choice); setOpen(false); setQuery(""); };
  return <Combobox items={rows} value={current} inputValue={query} onInputValueChange={setQuery} open={open}
    onOpenChange={next => { setOpen(next); if (next) { setQuery(""); setTab(choices.length === 1 ? choices[0].id : "all"); } }}
    itemToStringLabel={(item: Choice) => `${item.label} ${item.providerLabel} ${item.model}`} itemToStringValue={(item: Choice) => item.key}
    onValueChange={item => { if (item) choose(item); }}>
    <ComboboxTrigger role="combobox" aria-label="Model" disabled={disabled} data-value={model} title={[currentLabel, currentProvider].filter(Boolean).join(" · ")} className="model-picker-trigger model-select"><span className="model-trigger-label">{currentModel ? currentLabel : "Choose model"}</span>{currentProvider && <span className="model-trigger-provider">{currentProvider}</span>}<ChevronDown size={13} /></ComboboxTrigger>
    <ComboboxContent className="model-picker-content">
      <div className="model-search"><Search size={15} /><ComboboxInput aria-label="Search models" placeholder="Search models…" autoFocus /></div>
      <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="model-provider-tabs" aria-label="Model providers"><Tabs.Tab value="all">All</Tabs.Tab>{groups.length > 1 && groups.map(group => <Tabs.Tab key={group.id} value={group.id}>{group.label}</Tabs.Tab>)}</Tabs.List>
        <Tabs.Panel value={tab}>
          {catalog?.loading ? <p role="status" className="p-4 text-sm text-muted-foreground">Loading models from {activeConnection?.label}…</p> : catalog?.error ? <div className="p-3 text-sm"><p role="alert" className="text-destructive">{catalog.error}</p><div className="mt-2 flex gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setRetry(value => value + 1)}>Try again</Button>{onConfigure && <Button type="button" variant="outline" size="sm" onClick={() => { setOpen(false); onConfigure(); }}>Manage connections</Button>}</div></div> : <ComboboxEmpty>{tab !== "all" && !rows.length ? "This connection has not reported a model list." : "No matching models."}</ComboboxEmpty>}
          <ComboboxList>{(item: Choice) => <ComboboxItem key={item.key} value={item} data-value={item.model}><span className="model-option-name">{item.label}{item.description && <small title={item.description}>{item.description}</small>}</span><span className="model-option-provider">{item.providerLabel}</span></ComboboxItem>}</ComboboxList>
        </Tabs.Panel>
      </Tabs.Root>
      {allowCustom && configured.length > 0 && <details className="model-custom"><summary>Advanced: use an unlisted model</summary><div className="grid gap-2 pt-2"><OptionSelect aria-label="Provider" value={customProvider} onChange={e => setCustomProvider(e.target.value)}><option value="">Choose connection</option>{configured.map(provider => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</OptionSelect><Input aria-label="Model ID" placeholder="Model name supplied by this connection" value={customModel} maxLength={200} onChange={e => setCustomModel(e.target.value)} /><Button type="button" size="sm" disabled={!customProvider || !customModel.trim()} onClick={() => choose({ model: customModel.trim(), choiceId: customProvider })}>Use model</Button></div></details>}
    </ComboboxContent>
  </Combobox>;
}
