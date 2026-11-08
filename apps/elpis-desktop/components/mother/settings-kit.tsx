
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/settings-kit.tsx.
/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
export { SourceField } from "./settings-rows-field";
import { Field } from "./settings-rows-field";
export { Field, SwitchRow } from "./settings-rows-field";
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { ApiResponse } from "../../bridge/router/app/api.mts";

import { usePoll, type HistoryView, type Settings, type SettingsView, type SourceView } from "./api.ts";
import { DisclosureRow, Icon, Input } from "./controls.tsx";
import { useDraft } from "./draft.tsx";
import { usePanel, usePanelData } from "./provider.tsx";

import { errorText, localized, valueLabel, valueText, when, type T } from "./text.ts";
import { Hint, LoadState } from "./widgets.tsx";

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => (text.trim() ? Number(text) : null);
interface SettingsData {
  settings: SettingsView;
  reload: () => Promise<void>;
}
const SettingsContext = createContext<SettingsData | undefined>(undefined);
export function useSettings(): SettingsData {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("A settings block rendered outside the settings");
  return value;
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel();
  const { restarts } = usePanelData();
  const { data, error, reload } = usePoll(() => call("GET settings"), [call, restarts]);
  if (!data) return <LoadState error={error} loading />;
  return (
    <SettingsContext.Provider value={{ settings: data, reload }}>
      {error && <LoadState error={error} loading={false} />}
      {children}
    </SettingsContext.Provider>
  );
}
export function useBlockDraft<V>(
  block: string,
  saved: V,
  revision: number,
  toValue: (draft: V) => unknown = draft => draft,
) {
  const { t, call, notify } = usePanel();
  const { state } = usePanelData();
  const { reload } = useSettings();
  return useDraft({
    key: `mother/draft/${state?.masterId ?? ""}/${block}`,
    saved,
    revision,
    reload,
    save: async (value, from) => {
      const result = await call("PUT settings/:block", { block, body: { value: toValue(value), revision: from } });
      notify(t(result.restarting ? "savedRestarting" : "saved"));
      return result;
    },
  });
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null);
  const focused = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null;
    else if (focused.current && (!active || active === document.body)) {
      focused.current.focus({ preventScroll: true });
      focused.current = null;
    }
  }, [disabled]);
  return (
    <fieldset ref={set} className="dt-fieldset" disabled={disabled}>
      {children}
    </fieldset>
  );
}
type RoleModel = Settings["eval"]["model"];
export function ModelField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: RoleModel;
  onChange: (next: RoleModel) => void;
}) {
  const { t, call } = usePanel();
  const [catalog, setCatalog] = useState<ApiResponse<"GET models">>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    call("GET models").then(setCatalog, failure => setError(errorText(failure)));
  }, [call]);
  const current = { provider: value?.provider ?? "", model: value?.model ?? "", effort: value?.reasoningEffort ?? "" };
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next };
    onChange(
      provider.trim() || model.trim() || effort.trim()
        ? { provider, model, ...(effort ? { reasoningEffort: effort } : {}) }
        : null,
    );
  };
  const models = catalog?.groups.find(group => group.id === current.provider.trim())?.models ?? [];
  const fallback = catalog?.default;
  const input = (name: keyof typeof current, label: string, placeholder: string) => (
    <Field label={label}>
      <Input
        list={`${id}-${name}s`}
        spellCheck={false}
        placeholder={placeholder}
        value={current[name]}
        onChange={event => set({ [name]: event.target.value })}
      />
    </Field>
  );
  return (
    <div className="dt-model">
      <Hint>
        {fallback
          ? t("defaultModel", {
              model: `${fallback.provider} / ${fallback.model}${
                fallback.reasoningEffort ? ` · ${fallback.reasoningEffort}` : ""
              }`,
            })
          : t("defaultModelUnavailable")}
      </Hint>
      {error && <p className="dt-error">{t("modelCatalogError", { error })}</p>}
      <div className="settings-rows">
        {input("provider", t("modelProvider"), t("modelInherit"))}
        {input("model", t("modelName"), t("modelInherit"))}
        {input("effort", t("modelEffort"), t("modelEffortDefault"))}
      </div>
      <datalist id={`${id}-providers`}>
        {catalog?.groups.map(group => (
          <option key={group.id} value={group.id}>
            {group.name}
          </option>
        ))}
      </datalist>
      <datalist id={`${id}-models`}>
        {models.map(model => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </datalist>
      <datalist id={`${id}-efforts`}>
        {(models.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []).map(effort => (
          <option key={effort.id} value={effort.id}>
            {effort.name}
          </option>
        ))}
      </datalist>
    </div>
  );
}

type HistoryChange = NonNullable<HistoryView["items"][number]["changes"]>[number];
function changeText(t: T, change: HistoryChange, sources: SourceView[]): string {
  const source = sources.find(item => item.id === change.source);
  const field = (change.part ? source?.policy?.fields : source?.fields)?.find(item => item.key === change.field);
  const shown = (value: unknown) =>
    value === undefined || value === null || value === ""
      ? t("unsetValue")
      : typeof value === "boolean"
        ? t(value ? "yes" : "no")
        : change.code === "mode"
          ? valueLabel(t, "mode", valueText(value))
          : valueText(value);
  return t(`change.${change.code}`, {
    items: (change.items ?? []).map(item => source?.labels[item] ?? item).join(t("listSeparator")),
    from: shown(change.from),
    to: shown(change.to),
    name: change.name ?? "",
    source: source ? localized(t, source.title) : (change.source ?? ""),
    field: field ? localized(t, field.label) : (change.field ?? ""),
  });
}
/**
 * Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
 * Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
 */
export function ConfigHistory({
  blocks,
  versions,
  focus,
}: {
  blocks: string[];
  versions?: boolean | undefined;
  focus?: string | undefined;
}) {
  const { t, call } = usePanel();
  const { settings } = useSettings();
  const { sources } = settings;
  const [open, setOpen] = useState(!!focus);
  const [data, setData] = useState<HistoryView>();
  const [error, setError] = useState<string>();
  const revisions = JSON.stringify([
    Object.values(settings.blocks).map(block => block.revision),
    sources.map(source => source.revision),
  ]);
  useEffect(() => {
    if (open) call("GET policy/history").then(setData, failure => setError(errorText(failure)));
  }, [open, call, revisions]);
  const listed = (block: string | undefined) =>
    block
      ? blocks.some(item => item === block || (item.endsWith(":") && block.startsWith(item)))
      : blocks.includes("policy");
  const items = data?.items.filter(item => (versions && item.policyChanged) || listed(item.block)) ?? [];
  // Match the oldest save that produced the focused Policy version (where that version originated).
  const target = focus
    ? items.filter(item => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1)
    : undefined;
  const scroll = (element: HTMLLIElement | null) => {
    if (element && !element.dataset.scrolled) {
      element.dataset.scrolled = "1";
      element.scrollIntoView?.({ block: "center" });
    }
  };
  return (
    <DisclosureRow
      icon={<Icon name="history" />}
      title={t("configHistory")}
      open={open}
      onToggle={() => setOpen(!open)}
    >
      <div className="dt-disclosure-body">
        {error && <p className="dt-error">{error}</p>}
        {data && (
          <>
            <Hint>{t("historyIntro")}</Hint>
            {focus && !target && <Hint>{t("policyVersionUnrecorded", { version: focus.slice(0, 8) })}</Hint>}
            {items.length ? (
              <ul className="dt-timeline">
                {items.map(item => (
                  <li
                    key={item.revision}
                    className={item === target ? "dt-event dt-highlight" : "dt-event"}
                    ref={item === target ? scroll : undefined}
                  >
                    <div className="settings-row-title dt-row-title">
                      {t("historyItem", {
                        revision: item.revision,
                        source: valueLabel(t, "historySource", item.source),
                      })}
                    </div>
                    <div className="dt-event-foot">
                      {when(item.savedAt, t("lang"))}
                      {item.policyChanged && (
                        <> · {t("historyPolicyChanged", { version: item.policyVersion.slice(0, 8) })}</>
                      )}
                    </div>
                    {item.changes === null ? (
                      <Hint>{t("historyNoBaseline")}</Hint>
                    ) : item.changes.length ? (
                      <ul className="dt-changes">
                        {item.changes.map((change, index) => (
                          <li key={index}>{changeText(t, change, sources)}</li>
                        ))}
                      </ul>
                    ) : (
                      <Hint>{t("historyNoChanges")}</Hint>
                    )}
                    {item.notified.length > 0 && (
                      <Hint>
                        {t("historyNotified", {
                          count: item.notified.length,
                          titles: item.notified.map(ticket => ticket.title).join(t("listSeparator")),
                        })}
                      </Hint>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Hint>{t("historyEmpty")}</Hint>
            )}
          </>
        )}
      </div>
    </DisclosureRow>
  );
}
