// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/eval.tsx.
/** Eval status view (Decision log) and Eval settings group (Policy rules, per-Source admission, and assessor settings). */
export { RuleRow, SourcePart } from "./eval-admission";
export type { Rule, Part } from "./eval-admission";
import { PolicyBlock } from "./eval-admission";

import { Button as SharedButton } from "@/components/ui/button";
import { useState } from "react";

import { LIMITS } from "../../bridge/router/limits.mts";
import { DECISION_FILTERS, DECISION_KINDS, usePoll, type DecisionFilter } from "./api.ts";
import { InfoTip, Input, Pill, SegmentedControl } from "./controls.tsx";
import { SaveBar } from "./draft.tsx";
import { usePanel } from "./provider.tsx";
import { DecisionLine } from "./rows.tsx";
import { ConfigHistory, Field, Fields, ModelField, numberOf, useBlockDraft, useSettings } from "./settings-kit.tsx";
import { valueLabel } from "./text.ts";
import { Empty, LoadMore, LoadState, Section, StatusHead } from "./widgets.tsx";

export function EvalStatus({
  filter,
  window,
  paused,
}: {
  filter: DecisionFilter;
  window: "24h" | undefined;
  paused: boolean;
}) {
  const { t, call, navigate } = usePanel();
  const [limit, setLimit] = useState(30);
  const { data, error } = usePoll(
    () => call("GET decisions", { query: { limit, kind: DECISION_KINDS[filter], ...(window ? { window } : {}) } }),
    [filter, limit, window],
  );
  const show = (key: DecisionFilter, last24h: boolean) =>
    navigate(
      { page: "eval", query: { ...(key === "work" ? {} : { filter: key }), ...(last24h ? { window: "24h" } : {}) } },
      true,
    );
  return (
    <>
      <StatusHead hint={t("evalStatusIntro")} settings="eval" />
      {paused && (
        <p className="dt-banner">
          {t("evalRecordsPaused")}{" "}
          <SharedButton
            variant="link"
            size="content"
            type="button"
            className="dt-textlink p-0 justify-start text-left"
            onClick={() => navigate({ page: "execution" })}
          >
            {t("resumeWhere")}
          </SharedButton>
        </p>
      )}
      <div className="dt-filters">
        {DECISION_FILTERS.map(key => (
          <Pill
            key={key}
            active={filter === key}
            onClick={() => {
              setLimit(30);
              show(key, !!window);
            }}
          >
            {t(`decisionFilter.${key}`)}
          </Pill>
        ))}
        {window && (
          <>
            <span className="dt-filter-gap" />
            <Pill active onClick={() => show(filter, false)}>
              {t("lastDayOnly")}
            </Pill>
          </>
        )}
      </div>
      <LoadState error={error} loading={!data} />
      {data &&
        (data.items.length ? (
          <ul className="dt-list">
            {data.items.map(decision => (
              <DecisionLine key={decision.id} decision={decision} />
            ))}
          </ul>
        ) : (
          <Empty>{t("none")}</Empty>
        ))}
      {data?.next_offset != null && <LoadMore onMore={() => setLimit(limit + 30)} />}
    </>
  );
}

function EvalBlock() {
  const { t } = usePanel();
  const block = useSettings().settings.blocks.eval;
  const saved = { ...block.value, timeoutSeconds: String(block.value.timeoutSeconds) };
  const draft = useBlockDraft("eval", saved, block.revision, value => ({
    ...value,
    timeoutSeconds: numberOf(value.timeoutSeconds),
  }));
  const value = draft.value;
  const edit = (next: Partial<typeof value>) => draft.edit({ ...value, ...next });
  return (
    <form
      className="settings-card dt-form dt-block"
      onSubmit={event => {
        void draft.submit(event);
      }}
    >
      <Fields disabled={draft.busy}>
        <h2 className="dt-block-title">
          {t("evalSettings")}
          <InfoTip text={t("evalIntro")} />
        </h2>
        <Section title={t("acceptMode")} hint={t(`modeOption.${value.mode}`)}>
          <SegmentedControl
            label={t("acceptMode")}
            value={value.mode}
            onChange={mode => edit({ mode })}
            options={(["off", "observe", "auto"] as const).map(mode => ({
              value: mode,
              label: valueLabel(t, "mode", mode),
              title: t(`modeOption.${mode}`),
            }))}
          />
        </Section>
        <Field label={t("evalTimeout")} hint={t("evalTimeoutHint")}>
          <Input
            type="number"
            min={LIMITS.evalTimeoutSeconds.min}
            max={LIMITS.evalTimeoutSeconds.max}
            required
            value={value.timeoutSeconds}
            onChange={event => edit({ timeoutSeconds: event.target.value })}
          />
        </Field>
        <Section title={t("assessorModel")} hint={t("assessorModelHint")}>
          <ModelField id="dt-eval-model" value={value.model} onChange={model => edit({ model })} />
        </Section>
      </Fields>
      <SaveBar {...draft} onDiscard={draft.discard} />
    </form>
  );
}

export function EvalSettings({ version }: { version?: string | undefined }) {
  return (
    <div className="dt-form">
      <PolicyBlock />
      <EvalBlock />
      <ConfigHistory blocks={["policy", "eval"]} versions {...(version ? { focus: version } : {})} />
    </div>
  );
}
