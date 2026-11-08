import { Button as SharedButton } from "@/components/ui/button";
import { useState } from "react";
import { OptionSelect } from "@/components/ui/option-select";
import type { FieldSpec, Localized } from "../../bridge/router/sources/kind.mts";
import { Button, Icon, InfoTip, Input, SegmentedControl } from "./controls.tsx";
import { useAction, usePanel } from "./provider.tsx";
import { settingsRoute } from "./route.ts";
import { errorText, localized, valueText } from "./text.ts";

import { cloneElement, useId, type ReactElement, type ReactNode } from "react";
import { Textarea } from "@/components/ui/textarea";
import { SettingRow } from "@/components/settings/rows";
import { Switch } from "./controls.tsx";

export type Row = Record<string, string>;

export type Column = Extract<FieldSpec, { type: "rows" }>["columns"][number];

export const ROWS_SHOWN = 6;

export const byName = ([, a]: [string, string], [, b]: [string, string]) => a.localeCompare(b);

export function RowsField({
  field,
  value,
  saved,
  onChange,
  labels,
  refreshLabels,
}: {
  field: Extract<FieldSpec, { type: "rows" }>;
  value: unknown;
  saved: unknown;
  onChange: (next: unknown) => void;
  labels: Record<string, string>;
  refreshLabels: (() => Promise<string[]>) | undefined;
}) {
  const { t, notify } = usePanel();
  const [open, setOpen] = useState(false);
  const refresh = useAction(async () => {
    try {
      const added = await refreshLabels!();
      notify(added.length ? t("labelsAdded", { names: added.join(t("listSeparator")) }) : t("labelsCurrent"));
    } catch (failure) {
      notify(t("labelsFailed", { error: errorText(failure) }));
    }
  });
  const label = localized(t, field.label),
    hint = localized(t, field.hint);
  const rows = Array.isArray(value) ? (value as Row[]) : [];
  const set = (index: number, row: Row) => onChange(rows.map((item, position) => (position === index ? row : item)));
  const key = field.columns[0]!;
  const savedKeys = new Set((Array.isArray(saved) ? (saved as Row[]) : []).map(row => row[key.key]));
  const choose = key.type === "text" && key.choose && Object.keys(labels).length ? localized(t, key.choose) : "";
  // Exclude options already selected in another row.
  const choices = (id: string) =>
    Object.entries(labels)
      .filter(([option]) => option === id || !rows.some(other => other[key.key] === option))
      .sort(byName);
  const blank = Object.fromEntries(
    field.columns.map(column => [column.key, column.type === "select" ? column.options[0]!.value : ""]),
  );
  // Summarize a row by its second column only when that column is free text (e.g., a display name), not a select option.
  const named = field.columns[1]?.type === "text" ? field.columns[1] : undefined;
  const rowName = (row: Row) => (named && row[named.key]) || labels[row[key.key] ?? ""] || row[key.key] || "";
  const cell = (row: Row, index: number, column: Column) => {
    const id = row[key.key] ?? "",
      change = (next: string) => set(index, { ...row, [column.key]: next });
    if (column === key && (savedKeys.has(id) || (!choose && labels[id]))) {
      return (
        <span key={column.key} className={labels[id] ? "dt-row-label" : "dt-row-label dt-mono"} title={id}>
          {labels[id] ?? id}
        </span>
      );
    }
    if (column === key && choose) {
      return (
        <OptionSelect
          key={column.key}
          aria-label={choose}
          required
          value={id}
          onChange={event => change(event.target.value)}
        >
          <option value="" disabled>
            {choose}
          </option>
          {choices(id).map(([option, name]) => (
            <option key={option} value={option}>
              {name}
            </option>
          ))}
        </OptionSelect>
      );
    }
    if (column.type === "select") {
      return (
        <OptionSelect
          key={column.key}
          aria-label={localized(t, column.label)}
          value={row[column.key] ?? ""}
          onChange={event => change(event.target.value)}
        >
          {column.options.map(option => (
            <option key={option.value} value={option.value}>
              {localized(t, option.label)}
            </option>
          ))}
        </OptionSelect>
      );
    }
    return (
      <Input
        key={column.key}
        className={column.optional ? undefined : "dt-mono"}
        aria-label={localized(t, column.label)}
        placeholder={localized(t, column.label)}
        required={!column.optional}
        pattern={column.pattern}
        spellCheck={false}
        value={row[column.key] ?? ""}
        onChange={event => change(event.target.value)}
      />
    );
  };
  return (
    <div className="dt-field">
      <div className="dt-subhead">
        <span className="dt-field-head">
          {label}
          {hint && <InfoTip text={hint} />}
          <span className="dt-count">{rows.length || ""}</span>
        </span>
        <span className="dt-subhead-actions">
          {key.type === "text" && key.refresh && refreshLabels && (
            <Button
              variant="ghost"
              size="sm"
              className={refresh.busy ? "dt-btn-busy" : undefined}
              icon={<Icon name="refresh" />}
              disabled={refresh.busy}
              aria-busy={refresh.busy}
              onClick={() => {
                void refresh.run();
              }}
            >
              {localized(t, key.refresh)}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="plus" />}
            onClick={() => {
              setOpen(true);
              onChange([...rows, blank]);
            }}
          >
            {t("addRow")}
          </Button>
        </span>
      </div>
      {rows.length > ROWS_SHOWN && (
        <SharedButton
          variant="link"
          size="content"
          type="button"
          className="dt-textlink dt-rows-summary p-0 justify-start text-left"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? t("collapse") : rows.map(rowName).join(t("listSeparator"))}
        </SharedButton>
      )}
      {(rows.length <= ROWS_SHOWN || open) && (
        <ul className="dt-rows" style={{ ["--dt-columns" as string]: field.columns.length }}>
          {rows.map((row, index) => (
            <li key={index} className="dt-rows-item">
              {field.columns.map(column => cell(row, index, column))}
              <Button
                variant="ghost"
                size="sm"
                icon={<Icon name="trash" />}
                aria-label={t("removeRow", { name: labels[row[key.key] ?? ""] || row[key.key] || label })}
                onClick={() => onChange(rows.filter((_, position) => position !== index))}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SourceField({
  field,
  value,
  saved,
  fact,
  onChange,
  labels,
  refreshLabels,
}: {
  field: FieldSpec;
  value: unknown;
  saved: unknown;
  fact: Localized | string | undefined;
  onChange: (next: unknown) => void;
  labels: Record<string, string>;
  refreshLabels?: (() => Promise<string[]>) | undefined;
}) {
  const { t, navigate } = usePanel();
  const label = localized(t, field.label),
    hint = localized(t, field.hint);
  switch (field.type) {
    case "switch":
      return <SwitchRow label={label} hint={hint} checked={value === true} onChange={onChange} />;
    case "select":
      return (
        <Field label={label} hint={hint}>
          <SegmentedControl
            label={label}
            value={valueText(value ?? field.options[0]!.value)}
            options={field.options.map(option => ({ value: option.value, label: localized(t, option.label) }))}
            onChange={onChange}
          />
        </Field>
      );
    case "number":
      return (
        <Field label={label} hint={hint}>
          <Input
            type="number"
            min={field.min}
            max={field.max}
            required
            value={valueText(value)}
            onChange={event => onChange(event.target.value === "" ? "" : Number(event.target.value))}
          />
        </Field>
      );
    case "text":
      return (
        <Field label={label} hint={hint} note={localized(t, fact)}>
          {field.choose && Object.keys(labels).length ? (
            <OptionSelect value={valueText(value)} onChange={event => onChange(event.target.value)}>
              <option value="">{localized(t, field.choose)}</option>
              {value && !labels[valueText(value)] ? <option value={valueText(value)}>{valueText(value)}</option> : null}
              {Object.entries(labels)
                .sort(byName)
                .map(([option, name]) => (
                  <option key={option} value={option}>
                    {name}
                  </option>
                ))}
            </OptionSelect>
          ) : (
            <Input
              value={valueText(value)}
              readOnly={field.readonly}
              pattern={field.pattern}
              spellCheck={false}
              onChange={event => onChange(event.target.value)}
            />
          )}
        </Field>
      );
    case "fact":
      return (
        <div className="dt-field">
          <span className="dt-field-head">
            {label}
            {hint && <InfoTip text={hint} />}
          </span>
          <span className="dt-mono">{localized(t, fact) || t("empty")}</span>
          {field.settings && (
            <small>
              <SharedButton
                variant="link"
                size="content"
                type="button"
                className="dt-textlink p-0 justify-start text-left"
                onClick={() => navigate(settingsRoute(field.settings!))}
              >
                {t(`openSettingsOf.${field.settings}`)}
              </SharedButton>
            </small>
          )}
        </div>
      );
    case "rows":
      return (
        <RowsField
          field={field}
          value={value}
          saved={saved}
          onChange={onChange}
          labels={labels}
          refreshLabels={refreshLabels}
        />
      );
  }
}

export function Field({
  label,
  hint,
  note,
  children,
}: {
  label: string;
  hint?: string | undefined;
  note?: ReactNode | undefined;
  children: ReactElement<{ id?: string | undefined }>;
}) {
  const id = useId();
  return (
    <SettingRow
      stacked={children.type === Textarea}
      title={
        <span className="dt-field-head">
          <label htmlFor={id}>{label}</label>
          {hint && <InfoTip text={hint} />}
        </span>
      }
      description={note}
    >
      <div className="settings-field-stack w-full">{cloneElement(children, { id })}</div>
    </SettingRow>
  );
}

export function SwitchRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <SettingRow
      title={
        <span className="dt-field-head">
          {label}
          {hint && <InfoTip text={hint} />}
        </span>
      }
    >
      <Switch checked={checked} onChange={onChange} label={label} />
    </SettingRow>
  );
}
