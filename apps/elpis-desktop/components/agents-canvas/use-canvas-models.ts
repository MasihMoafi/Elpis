import { useEffect, useMemo } from "react";
import { api, providerChoices, type Model, type ProviderSettings } from "@/lib/api";
import { refreshModelCatalog } from "@/lib/model-catalog";
import { useElpisSettings } from "@/lib/settings-store";
import { type CanvasGraph, type CatalogModel } from "@/lib/canvas";
import { errorText } from "@/lib/error-text.mts";
import type * as React from "react";
import { Provider, Props } from "./types";

const catalogs = new Map<string, { version: string; models?: Model[]; error?: string }>();

export function useCanvasModels({ models, settings, setFetched, pendingProviderDefaults, setGraph }: {
  models: Props["models"];
  settings: ReturnType<typeof useElpisSettings>["data"];
  setFetched: React.Dispatch<React.SetStateAction<number>>;
  pendingProviderDefaults: React.RefObject<Map<string, { provider: string | null; model: string | null; effort: string | null; }>>;
  setGraph: React.Dispatch<React.SetStateAction<CanvasGraph>>
}) {
  // The existing provider catalog, shared by Add and the inspector; execution uses ACP.
  const allChoices = useMemo(() => providerChoices(models, (settings ?? null) as ProviderSettings | null), [models, settings]);
  const choices = useMemo(() => allChoices.filter(choice => !choice.id.endsWith("/")), [allChoices]);
  // Antigravity and Claude: the model carries the route (agy/, claude/), so an agent on one keeps no provider (lib/api.ts).
  const subscriptions = allChoices.filter(choice => choice.id.endsWith("/"));
  const version = settings?.version ?? "";
  // Opening Workflows lists every model live again: the engine's list and each connection's own.
  useEffect(() => { catalogs.clear(); void refreshModelCatalog(); }, []);
  useEffect(() => {
    for (const choice of choices) {
      if (!choice.provider || choice.needsKey || catalogs.get(choice.provider)?.version === version) continue;
      const provider = choice.provider;
      catalogs.set(provider, { version });
      api<{ data: Model[] }>(`/models?provider=${encodeURIComponent(provider)}&refresh=true`)
        .then(result => catalogs.set(provider, { version, models: result.data }))
        .catch(cause => catalogs.set(provider, { version, error: errorText(cause) }))
        .finally(() => setFetched(count => count + 1));
    }
  }, [choices, version]);
  const listed = (choice: (typeof choices)[number]) => choice.provider ? catalogs.get(choice.provider)?.models ?? [] : choice.models;
  const catalog: CatalogModel[] = choices.flatMap(choice => listed(choice).map(model => ({ provider: choice.provider ?? null, providerLabel: choice.label, model: model.model, label: model.displayName || model.model,
    efforts: model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? [], defaultEffort: model.defaultReasoningEffort ?? null })));
  const providers = choices.map(choice => {
    const fetched = choice.provider ? catalogs.get(choice.provider) : undefined;
    return { id: choice.provider ?? null, label: choice.label, state: choice.needsKey ? "key" : fetched?.error ? "error" : choice.provider && !fetched?.models ? "loading" : "ready", error: fetched?.error } satisfies Provider;
  });
  const primaryProvider = choices[0]?.provider ?? null;
  const canonicalProvider = (provider?: string | null) => !provider || provider === settings?.main.provider ? primaryProvider : provider;
  const providerDefault = (provider: string | null) => catalog.find(item => item.provider === provider && provider === primaryProvider && item.model === settings?.main.model) ?? catalog.find(item => item.provider === provider);
  useEffect(() => {
    if (!pendingProviderDefaults.current.size) return;
    const patches = new Map<string, { provider: string | null; model: string; effort: string | null }>();
    for (const [id, pending] of pendingProviderDefaults.current) {
      const keep = catalog.find(item => item.provider === pending.provider && item.model === pending.model);
      const model = keep ?? providerDefault(pending.provider);
      if (!model) continue;
      pendingProviderDefaults.current.delete(id); patches.set(id, { provider: pending.provider, model: model.model, effort: keep?.efforts.includes(pending.effort ?? "") ? pending.effort : null });
    }
    if (patches.size) setGraph(current => ({ ...current, nodes: current.nodes.map(node => {
      const patch = patches.get(node.id);
      return node.type === "agent" && patch && canonicalProvider(node.data.provider) === patch.provider && !node.data.model ? { ...node, data: { ...node.data, model: patch.model, effort: patch.effort } } : node;
    }) }));
  });
  return { catalog, canonicalProvider, subscriptions, providers, providerDefault, choices };
}