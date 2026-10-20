"use client";

import type { ReactNode } from "react";
import { Choice, SettingRow, SettingsNotice, type SettingScope } from "@/components/settings/rows";
import { useElpisSettings, type ConfigOptions, type ElpisSettings } from "@/lib/settings-store";

/** Renders its page once the shared Elpis settings snapshot has loaded. */
export function SettingsLoader({ children }: { children: (settings: ElpisSettings) => ReactNode }) {
  const { data, error } = useElpisSettings();
  if (!data) return error ? <SettingsNotice tone="alert">Could not load settings: {error}</SettingsNotice> : <SettingsNotice>Loading settings…</SettingsNotice>;
  return <>{children(data)}</>;
}

type Values = { value: string; label: string }[];
/** One enumerated Elpis config option as a row; "Elpis default" removes the key. Saves on change. */
export function ConfigChoice({ settings, name, title, description, values, allowed, disabled, onSave, scope }: {
  settings: ElpisSettings; name: keyof ConfigOptions; title: string; description: string; values: Values;
  allowed?: string[] | null; disabled: boolean; onSave: (patch: Partial<ConfigOptions>) => void; scope?: SettingScope;
}) {
  const current = settings.options?.[name];
  const value = typeof current === "string" ? current : "";
  const options = [{ value: "", label: "Elpis default" }, ...values.map(item => ({ ...item, disabled: Array.isArray(allowed) && !allowed.includes(item.value) }))];
  if (value && !values.some(item => item.value === value)) options.push({ value, label: value === "granular" || value === "custom" ? "Custom (set in the config file)" : value, disabled: true });
  return <SettingRow title={title} description={description} scope={scope}>
    <Choice label={title} value={value} options={options} disabled={disabled} onChange={next => { if (next !== value) onSave({ [name]: next || null }); }} />
  </SettingRow>;
}
