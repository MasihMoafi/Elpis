import { OptionSelect } from "@/components/ui/option-select";
import { useState } from "react";
import {
  ADMISSION_DEFAULTS,
  ADMISSION_OPTIONS,
  type Admission,
  type AdmissionCell,
} from "../../bridge/router/admission.mts";
import type { AdmissionRowView } from "../../bridge/router/sources/kind.mts";
import { LIMITS } from "../../bridge/router/limits.mts";
import { Button, Icon, InfoTip, SegmentedTabs } from "./controls.tsx";
import { SaveBar } from "./draft.tsx";
import { usePanel } from "./provider.tsx";
import { Fields, useBlockDraft, useSettings } from "./settings-kit.tsx";
import { localized } from "./text.ts";
import { Hint, LabelValue, Section } from "./widgets.tsx";

import { Textarea } from "@/components/ui/textarea";

import { type Settings, type SourceView } from "./api.ts";
import { DisclosureRow, Input, Switch } from "./controls.tsx";
import { useAction } from "./provider.tsx";
import { Field, SourceField } from "./settings-kit.tsx";
import { when } from "./text.ts";

export type AdmissionTable = Record<string, Partial<Record<AdmissionCell, Admission>>>;

export const CELLS: readonly AdmissionCell[] = ["listedUnaddressed", "unlistedAddressed", "unlistedUnaddressed"];

export function AdmissionTable({
  rows,
  labels,
  table,
  explicit,
  onChange,
}: {
  rows: AdmissionRowView[];
  labels: Record<string, string>;
  table: AdmissionTable;
  explicit: string;
  onChange: (table: AdmissionTable) => void;
}) {
  const { t } = usePanel();
  const name = (row: AdmissionRowView) => labels[row.id] ?? localized(t, row.label);
  const set = (row: string, cell: AdmissionCell, value: Admission) =>
    onChange({ ...table, [row]: { ...table[row], [cell]: value } });
  const select = (row: AdmissionRowView, cell: AdmissionCell) => {
    const value = table[row.id]?.[cell] ?? ADMISSION_DEFAULTS[cell];
    // Reserve a fixed-width slot for the warning icon so selecting a value never shifts column widths.
    return (
      <td key={cell}>
        <span className="dt-admission-cell">
          <OptionSelect
            aria-label={`${name(row)} · ${t(`admissionCell.${cell}`)}`}
            value={value}
            onChange={event => set(row.id, cell, event.target.value as Admission)}
          >
            {ADMISSION_OPTIONS[cell].map(option => (
              <option key={option} value={option}>
                {t(`admissionValue.${option}`)}
              </option>
            ))}
          </OptionSelect>
          <span className="dt-admission-slot">
            {cell === "unlistedAddressed" && value === "explicit" && (
              <InfoTip text={t("admissionAnyoneWarning")} icon="alert" warn />
            )}
          </span>
        </span>
      </td>
    );
  };
  return (
    <Section title={t("admission")} hint={t("admissionHint")}>
      <Hint>{explicit}</Hint>
      <table className="dt-table dt-admission">
        <thead>
          <tr>
            <th rowSpan={2}>{t("admissionScope")}</th>
            <th>{t("admissionListed")}</th>
            <th colSpan={2}>{t("admissionUnlisted")}</th>
          </tr>
          <tr>
            <th>{t("admissionUnaddressed")}</th>
            <th>{t("admissionAddressed")}</th>
            <th>{t("admissionUnaddressed")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.id}>
              <td className="dt-admission-scope">
                {name(row)}
                <small>{localized(t, row.note)}</small>
              </td>
              {CELLS.map(cell =>
                row.cells[cell] ? (
                  select(row, cell)
                ) : (
                  <td key={cell} className="dt-admission-na" aria-label={t("admissionNotReceived")}>
                    —
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <Hint>{t("admissionFootnote")}</Hint>
    </Section>
  );
}

export function PolicyBlock() {
  const { t } = usePanel();
  const {
    settings: { blocks, sources, policyVersion },
    reload,
  } = useSettings();
  const draft = useBlockDraft("policy", blocks.policy.value, blocks.policy.revision);
  const policy = draft.value;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const parts = sources.filter(source => source.installed && source.policy);
  const [tab, setTab] = useState<string>();
  const current = parts.find(source => source.id === tab) ?? parts[0];
  const edit = (next: Partial<typeof policy>) => draft.edit({ ...policy, ...next });
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  const insert = (rule: Rule, at: number) => {
    setExpanded(new Set([...expanded, rule.id]));
    edit({ rules: [...policy.rules.slice(0, at), rule, ...policy.rules.slice(at)] });
  };
  // Expand all rules when native form validation fails inside a collapsed rule.
  const reveal = (target: EventTarget) => {
    if (target instanceof Element && target.closest(".dt-rules"))
      setExpanded(new Set(policy.rules.map(rule => rule.id)));
  };
  const part = (id: string) => (policy.sources[id] ?? { allowed: [] }) as Part;
  const add = () => insert({ id: crypto.randomUUID(), name: "", enabled: true, instruction: "" }, policy.rules.length);
  return (
    <form
      className="settings-card dt-form dt-block"
      onSubmit={event => {
        void draft.submit(event);
      }}
      onInvalidCapture={event => reveal(event.target)}
    >
      <Fields disabled={draft.busy}>
        <h2 className="dt-block-title">
          {t("term.policy")}
          <InfoTip text={t("policyIntro")} />
        </h2>
        <p className="dt-flow">
          <LabelValue label={t("policyVersion")} value={<span className="dt-mono">{policyVersion.slice(0, 8)}</span>} />
          <InfoTip text={t("policyVersionHint")} />
        </p>
        <Section
          title={t("rules")}
          hint={t("rulesHint")}
          action={
            <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={add}>
              {t("addRule")}
            </Button>
          }
        >
          {policy.rules.length ? (
            <ul className="dt-rules">
              {policy.rules.map((rule, index) => (
                <RuleRow
                  key={rule.id}
                  rule={rule}
                  expanded={expanded.has(rule.id)}
                  onToggle={() => toggle(rule.id)}
                  onChange={next =>
                    edit({ rules: policy.rules.map((item, position) => (position === index ? next : item)) })
                  }
                  onDuplicate={() =>
                    insert(
                      {
                        ...rule,
                        id: crypto.randomUUID(),
                        name: `${rule.name}${t("copySuffix")}`.slice(0, LIMITS.ruleName),
                      },
                      index + 1,
                    )
                  }
                  onRemove={() => edit({ rules: policy.rules.filter((_, position) => position !== index) })}
                />
              ))}
            </ul>
          ) : (
            <Hint>{t("rulesEmpty")}</Hint>
          )}
        </Section>
        {current && (
          <Section title={t("policyPerSource")} hint={t("policyPerSourceHint")}>
            {parts.length > 1 && (
              <SegmentedTabs
                label={t("policyPerSource")}
                value={current.id}
                onChange={setTab}
                items={parts.map(source => ({
                  value: source.id,
                  label: localized(t, source.title),
                  id: `dt-policy-${source.id}`,
                  panelId: "dt-policy-source",
                }))}
              />
            )}
            <div
              id="dt-policy-source"
              role="tabpanel"
              aria-labelledby={parts.length > 1 ? `dt-policy-${current.id}` : undefined}
            >
              <SourcePart
                key={current.id}
                source={current}
                part={part(current.id)}
                saved={(blocks.policy.value.sources[current.id] ?? {}) as Part}
                dirty={draft.dirty}
                reload={reload}
                onChange={next =>
                  edit({ sources: { ...policy.sources, [current.id]: next as (typeof policy.sources)[string] } })
                }
              />
            </div>
          </Section>
        )}
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  );
}

export type Rule = Settings["policy"]["rules"][number];

export function RuleRow({
  rule,
  expanded,
  onToggle,
  onChange,
  onDuplicate,
  onRemove,
}: {
  rule: Rule;
  expanded: boolean;
  onToggle: () => void;
  onChange: (rule: Rule) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const { t } = usePanel();
  const name = rule.name.trim() || t("newRule");
  return (
    <li className="dt-rule">
      <DisclosureRow
        icon={<span className="dt-rule-dot" data-enabled={rule.enabled || undefined} />}
        title={name}
        open={expanded}
        onToggle={onToggle}
        collapsedContent={<span className="dt-rule-preview">{rule.instruction}</span>}
      >
        <div className="dt-rule-body">
          <Field label={t("ruleName")}>
            <Input
              value={rule.name}
              required
              maxLength={LIMITS.ruleName}
              onChange={event => onChange({ ...rule, name: event.target.value })}
            />
          </Field>
          <Field label={t("ruleInstruction")}>
            <Textarea
              rows={4}
              required
              maxLength={LIMITS.ruleInstruction}
              value={rule.instruction}
              placeholder={t("ruleInstructionPlaceholder")}
              onChange={event => onChange({ ...rule, instruction: event.target.value })}
            />
          </Field>
          <div className="dt-actions">
            <Button variant="ghost" size="sm" icon={<Icon name="copy" />} onClick={onDuplicate}>
              {t("duplicate")}
            </Button>
            <Button variant="ghost" size="sm" icon={<Icon name="trash" />} onClick={onRemove}>
              {t("remove")}
            </Button>
          </div>
        </div>
      </DisclosureRow>
      <Switch
        className="dt-rule-switch"
        checked={rule.enabled}
        onChange={enabled => onChange({ ...rule, enabled })}
        label={t("ruleEnable", { name })}
      />
    </li>
  );
}

export type Part = Record<string, unknown>;

export function SourcePart({
  source,
  part,
  saved,
  dirty,
  onChange,
  reload,
}: {
  source: SourceView;
  part: Part;
  saved: Part;
  dirty: boolean;
  onChange: (next: Part) => void;
  reload: () => Promise<void>;
}) {
  const { t, call, notify } = usePanel();
  const policy = source.policy!;
  const sync = policy.sync;
  const run = useAction(() => call("POST policy-sync/:id", { id: source.id }), { reload });
  // Syncing saves the Policy block, so require unsaved edits to be saved or discarded first.
  const syncNow = () => {
    if (dirty) notify(t("syncNeedsSave"));
    else void run.run();
  };
  return (
    <div className="dt-part">
      {policy.fields.map(field => (
        <SourceField
          key={field.key}
          field={field}
          value={part[field.key]}
          saved={saved[field.key]}
          fact={undefined}
          labels={source.labels}
          onChange={next => onChange({ ...part, [field.key]: next })}
        />
      ))}
      {sync && (
        <div className="dt-row-buttons">
          <Button
            variant="outline"
            size="sm"
            icon={<Icon name="refresh" />}
            disabled={run.busy || !sync.ready}
            onClick={syncNow}
          >
            {localized(t, sync.label)}
          </Button>
          {sync.health?.state === "ready" && sync.health.at && (
            <LabelValue label={t("syncDone")} value={when(sync.health.at, t("lang"))} />
          )}
          {sync.health?.state === "error" && <span className="dt-error dt-clamp">{sync.health.detail}</span>}
        </div>
      )}
      {policy.rows ? (
        <AdmissionTable
          rows={policy.rows}
          labels={source.labels}
          table={(part.admission ?? {}) as AdmissionTable}
          explicit={localized(t, policy.explicit)}
          onChange={admission => onChange({ ...part, admission })}
        />
      ) : (
        <div className="dt-field">
          <span className="dt-field-head">{t("explicitRequest")}</span>
          <span>{localized(t, policy.explicit)}</span>
        </div>
      )}
    </div>
  );
}
