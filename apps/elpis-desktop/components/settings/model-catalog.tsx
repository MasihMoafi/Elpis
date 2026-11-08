"use client";

import { DisclosureSummary } from "@/components/ui/disclosure-summary";
import { useEffect, useRef, useState } from "react";
import {
  api,
  SUBSCRIPTIONS,
  connectionOrder,
  isListedProvider,
  providerLabel,
  subscriptionOf,
  type Model,
} from "@/lib/api";
import { OptionSelect } from "@/components/ui/option-select";
import { Input } from "@/components/ui/input";
import { type ElpisSettings } from "@/lib/settings-store";
import { modelCatalogSnapshot, refreshModelCatalog, subscribeModelCatalog } from "@/lib/model-catalog";
import { errorText } from "@/lib/error-text.mts";

// Background model, Smart Prune and memory settings (formerly the "Elpis" page), each saved
// through the bridge's versioned config writer.
export const shown = (value: string | boolean | null | undefined) =>
  typeof value === "boolean" ? (value ? "Enabled" : "Disabled") : value || "Not reported";

export const reloaded = { ok: true, text: "Settings reloaded. Unsaved edits were discarded." };

/** Settings' model menus: the shared live list (lib/model-catalog.ts), refreshed as the page opens. */
export function useModelCatalog() {
  const [catalog, setCatalog] = useState(modelCatalogSnapshot);
  useEffect(() => {
    const stop = subscribeModelCatalog(() => setCatalog(modelCatalogSnapshot()));
    void refreshModelCatalog();
    return stop;
  }, []);
  return { models: catalog.models, error: catalog.error };
}

/** Model lists by configured connection; another connection's catalog is read from its own endpoint. */
export function useProviderCatalogs(value: ElpisSettings, models: Model[], selected: (string | null)[]) {
  const mainModels = models.filter(model => !subscriptionOf(model.model));
  const [catalogs, setCatalogs] = useState<
    Record<string, { version: string | null | undefined; models: Model[]; loading?: boolean; error?: string }>
  >({});
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const catalogFor = (provider: string) =>
    catalogs[provider]?.version === value.version ? catalogs[provider] : undefined;
  const wanted = selected.join("\n");
  useEffect(() => {
    const version = value.version;
    for (const provider of new Set(wanted.split("\n"))) {
      if (
        !provider ||
        provider === value.main.provider ||
        catalogFor(provider) ||
        !value.providers?.some(item => item.id === provider)
      )
        continue;
      setCatalogs(old => ({ ...old, [provider]: { version, models: [], loading: true } }));
      api<{ data: Model[] }>("/models?provider=" + encodeURIComponent(provider) + "&refresh=true")
        .then(result => {
          if (!Array.isArray(result?.data)) throw new Error("Model catalog response did not contain models.");
          if (active.current)
            setCatalogs(old =>
              old[provider]?.version === version ? { ...old, [provider]: { version, models: result.data } } : old,
            );
        })
        .catch(error => {
          if (active.current)
            setCatalogs(old =>
              old[provider]?.version === version
                ? { ...old, [provider]: { version, models: [], error: errorText(error) } }
                : old,
            );
        });
    }
  }, [wanted, value.main.provider, value.providers, value.version, catalogs]);
  return {
    mainModels,
    forProvider: (provider: string | null) =>
      !provider || provider === value.main.provider ? mainModels : (catalogFor(provider)?.models ?? []),
    connectionLabel: (provider: string | null) =>
      providerLabel(null, provider ?? value.main.provider, value.providers) || "the conversation provider",
    catalogStatus: (provider: string | null) => {
      const catalog = provider ? catalogFor(provider) : undefined;
      return catalog?.loading
        ? "Loading model choices…"
        : catalog?.error
          ? "Model choices could not be loaded: " + catalog.error
          : undefined;
    },
  };
}

export function ModelChoice({
  label,
  value,
  models,
  provider,
  catalogStatus,
  disabled,
  inheritLabel,
  onChange,
}: {
  label: string;
  value: string | null;
  models: Model[];
  provider: string;
  catalogStatus?: string | undefined;
  disabled: boolean;
  inheritLabel?: string | undefined;
  onChange: (value: string | null) => void;
}) {
  return (
    <div role="group" aria-label={`${label} choices`} className="settings-field-stack text-sm">
      {models.length ? (
        <OptionSelect
          aria-label={label}
          className="settings-choice"
          value={value ?? ""}
          onChange={event => onChange(event.target.value || null)}
          disabled={disabled}
        >
          {inheritLabel ? (
            <option value="">{inheritLabel}</option>
          ) : (
            !value && (
              <option value="" disabled>
                Choose a model
              </option>
            )
          )}
          {value && !models.some(model => model.model === value) && (
            <option value={value}>Current configured model</option>
          )}
          {models.map(model => (
            <option key={model.model} value={model.model}>
              {model.displayName || model.model}
            </option>
          ))}
        </OptionSelect>
      ) : (
        <span className="text-muted-foreground">
          {value ? "Current configured model" : (inheritLabel ?? "No model chosen")}
        </span>
      )}
      {catalogStatus && (
        <span role="status" className="text-xs text-muted-foreground">
          {catalogStatus}
        </span>
      )}
      <details>
        <DisclosureSummary className="cursor-pointer">Advanced: custom model</DisclosureSummary>
        <p className="text-xs text-muted-foreground">
          {models.length
            ? `Enter a model ID supported by ${provider}.`
            : `No model catalog is available for ${provider}.`}
        </p>
        <Input
          aria-label={models.length ? `Custom ${label}` : label}
          value={value ?? ""}
          onChange={event => onChange(event.target.value.trim() || null)}
          placeholder="Model name supplied by this connection"
          maxLength={200}
          disabled={disabled}
        />
      </details>
    </div>
  );
}

/** Connections in one order. Subscriptions are named by model prefix (claude/…), so they need no configured connection. */
export function providerOptions(
  current: string,
  providers: ElpisSettings["providers"] = [],
  subscribed?: { models: Model[]; valueOf: (item: (typeof SUBSCRIPTIONS)[number]) => string },
) {
  const listed = providers
    .filter(item => item.id === current || isListedProvider(item.id))
    .map(item => ({ id: item.id, label: providerLabel(null, item.id, providers), value: item.id }));
  const subscriptions = subscribed
    ? SUBSCRIPTIONS.filter(item => subscribed.models.some(model => model.model.startsWith(item.prefix))).map(item => ({
        id: item.prefix,
        label: item.label,
        value: subscribed.valueOf(item),
      }))
    : [];
  return (
    <>
      {current && !providers.some(item => item.id === current) && <option value={current}>{current}</option>}
      {connectionOrder([...subscriptions, ...listed]).map(item => (
        <option key={item.id} value={item.value}>
          {item.label}
        </option>
      ))}
    </>
  );
}
