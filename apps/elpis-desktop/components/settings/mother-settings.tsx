"use client";

import { useEffect, useState } from "react";
import { api, effortsOf, SUBSCRIPTIONS, type Model } from "@/lib/api";
import { errorText } from "@/lib/error-text.mts";
import type { ElpisSettings } from "@/lib/settings-store";
import type { MotherSettings } from "../../bridge/router/settings.mts";
import type { RoleModel } from "../../bridge/router/executor/settings.mts";
import { Button } from "@/components/ui/button";
import { OptionSelect } from "@/components/ui/option-select";
import { Switch } from "@/components/ui/switch";
import { Choice, SettingRow, SettingsActions, SettingsGroup, SettingsNotice } from "@/components/settings/rows";
import { ModelChoice, providerOptions, useProviderCatalogs } from "@/components/settings/maintenance";

type Role = keyof MotherSettings["roles"];
const ROLES: [Role, string][] = [
  ["dispatch", "Elpis routing"],
  ["worker", "Elpis workers"],
];
function RoleChoice({
  role,
  label,
  value,
  settings,
  models,
  disabled,
  onChange,
}: {
  role: Role;
  label: string;
  value: RoleModel | null;
  settings: ElpisSettings;
  models: Model[];
  disabled: boolean;
  onChange: (value: RoleModel | null) => void;
}) {
  const inherited = settings.background.model ? settings.background : settings.main;
  const provider = value?.provider ?? inherited.provider ?? settings.main.provider ?? "";
  const catalogs = useProviderCatalogs(settings, models, [provider]);
  const subscription = SUBSCRIPTIONS.find(item => item.id === provider);
  const offered = subscription
    ? models.filter(model => model.model.startsWith(subscription.prefix))
    : catalogs.forProvider(provider);
  const efforts = effortsOf(value?.model ?? inherited.model, offered);
  return (
    <>
      <SettingRow
        title={`${label} provider`}
        description={
          role === "dispatch"
            ? "Routes goals and replies in the Elpis chat."
            : "Used when Elpis starts a new worker session."
        }
      >
        <OptionSelect
          aria-label={`${label} provider`}
          className="settings-choice"
          value={value?.provider ?? ""}
          disabled={disabled}
          onChange={event => {
            const next = SUBSCRIPTIONS.find(item => item.id === event.target.value);
            onChange(
              event.target.value
                ? {
                    provider: event.target.value,
                    model: next ? (models.find(model => model.model.startsWith(next.prefix))?.model ?? "") : "",
                  }
                : null,
            );
          }}
        >
          <option value="">Use background model (then main)</option>
          {providerOptions(subscription ? "" : provider, settings.providers, { models, valueOf: item => item.id })}
        </OptionSelect>
      </SettingRow>
      <SettingRow title={`${label} model`}>
        <ModelChoice
          label={`${label} model`}
          value={value?.model ?? null}
          models={offered}
          provider={catalogs.connectionLabel(provider)}
          catalogStatus={catalogs.catalogStatus(provider)}
          disabled={disabled}
          inheritLabel="Use background model (then main)"
          onChange={model =>
            onChange(
              model
                ? { provider, model, ...(value?.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
                : null,
            )
          }
        />
      </SettingRow>
      {value && efforts.length > 0 && (
        <SettingRow title={`${label} effort`}>
          <Choice
            label={`${label} effort`}
            value={value.reasoningEffort ?? ""}
            disabled={disabled}
            options={[
              { value: "", label: "Model default" },
              ...efforts.map(effort => ({ value: effort, label: effort })),
            ]}
            onChange={reasoningEffort =>
              onChange({
                provider: value.provider,
                model: value.model,
                ...(reasoningEffort ? { reasoningEffort } : {}),
              })
            }
          />
        </SettingRow>
      )}
    </>
  );
}

export function MotherAgentSettings({
  settings,
  models,
  onOpenMother,
}: {
  settings: ElpisSettings;
  models: Model[];
  onOpenMother?: (() => void) | undefined;
}) {
  const [value, setValue] = useState<MotherSettings | null>(null),
    [draft, setDraft] = useState<MotherSettings["roles"] | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    void api<MotherSettings>("/mother-agent")
      .then(value => {
        if (live) setValue(value);
      })
      .catch(error => {
        if (live) setError(errorText(error));
      });
    return () => {
      live = false;
    };
  }, []);
  async function save(patch: { enabled?: boolean; roles?: MotherSettings["roles"] }) {
    if (!value || busy) return;
    setBusy(true);
    setError("");
    try {
      setValue(await api<MotherSettings>("/mother-agent", { version: value.version, ...patch }));
      setDraft(null);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const failed = value?.error || Object.values(value?.health ?? {}).find(entry => entry.state === "error")?.detail;
  return (
    <SettingsGroup
      title="Elpis"
      description="Give Elpis a goal in its pinned chat. It routes the goal to workers and brings the result back there."
    >
      {onOpenMother && (
        <SettingsActions>
          <Button variant="outline" onClick={onOpenMother}>
            Open Elpis panel
          </Button>
        </SettingsActions>
      )}
      <SettingRow
        title="Enable Elpis"
        description="On by default. Turning it off stops its workers; the chat and unfinished work are kept."
      >
        <Switch
          aria-label="Enable Elpis"
          checked={value?.enabled ?? false}
          disabled={!value || busy}
          onCheckedChange={enabled => void save({ enabled })}
        />
      </SettingRow>
      {value &&
        ROLES.map(([role, label]) => (
          <RoleChoice
            key={role}
            role={role}
            label={label}
            value={(draft ?? value.roles)[role]}
            settings={settings}
            models={models}
            disabled={busy}
            onChange={choice => setDraft(previous => ({ ...(previous ?? value.roles), [role]: choice }))}
          />
        ))}
      {draft && (
        <SettingsActions>
          <Button
            disabled={busy || Object.values(draft).some(role => role && !role.model)}
            onClick={() => void save({ roles: draft })}
          >
            Save Elpis models
          </Button>
        </SettingsActions>
      )}
      {(error || failed) && <SettingsNotice tone="alert">{error || failed}</SettingsNotice>}
    </SettingsGroup>
  );
}
