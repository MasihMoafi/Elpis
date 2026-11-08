import { FullPrompt } from "./full-prompt";
import { Diff, PromptHistory } from "./prompt-history";

import { Textarea } from "@/components/ui/textarea";
import { Button as SharedButton } from "@/components/ui/button";
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/prompts.tsx.
/** Prompts settings group: section/skill editor, full composed prompt preview with diffing, and revision history. */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { PromptConfig, PromptsView } from "./api.ts";
import { SaveBar, useDraft } from "./draft.tsx";
import type { DraftWords } from "./draft-state";
import { changedSections, isPart, isSkill, lineDiff, partKey, partText, sectionLabel, sectionText, skillNameFree, withOverride, withOverrides, withSection, withoutSkill, type BuiltInPart } from "./prompt-config.ts";
import { usePanel } from "./provider.tsx";
import { errorText, type T } from "./text.ts";
import { Hint, LoadState } from "./widgets.tsx";
import { Button, Icon, Input, SegmentedTabs } from "./controls.tsx";

type Tab = "edit" | "full" | "history";
export type Origin = { revision: number } | "defaults" | { reset: string };
interface PromptNote {
  from?: Origin | undefined;
  selection?: string | undefined;
}
const originText = (t: T, view: PromptsView, from: Origin | undefined): string | undefined =>
  from === undefined
    ? undefined
    : from === "defaults"
      ? t("promptDraftFromDefaults")
      : "revision" in from
        ? t("promptDraftFromHistory", { revision: from.revision })
        : t("promptDraftSectionReset", { part: sectionLabel(t, view, from.reset) });

export function PromptsPage() {
  const { call } = usePanel();
  const [view, setView] = useState<PromptsView>();
  const [error, setError] = useState<Error>();
  const reload = useCallback(async () => {
    setView(await call("GET prompts"));
  }, [call]);
  useEffect(() => {
    reload().catch(setError);
  }, [reload]);
  return view ? <PromptsEditor view={view} reload={reload} /> : <LoadState loading error={error} />;
}

function PromptsEditor({ view, reload }: { view: PromptsView; reload: () => Promise<void> }) {
  const { t, call, notify } = usePanel();
  const saved = withOverrides(view.current.config);
  const draft = useDraft<PromptConfig, PromptNote>({
    key: `mother/prompts/${view.masterId}`,
    saved,
    revision: view.revision,
    reload,
    save: async (config, baseRevision) => {
      const result = await call("PUT prompts", { body: { config, baseRevision } });
      notify(t(result.context_delivery === "pending" ? "promptSavedPending" : "saved"));
      return result;
    },
  });
  const config = draft.value;
  const [tab, setTab] = useState<Tab>("edit");
  const [selection, select] = useState(draft.meta?.selection ?? "communication");
  // Fall back to the first section when the selected section (e.g., a skill removed by discard) is no longer in the draft.
  const exists = isPart(selection)
    ? view.parts.some(part => part.key === partKey(selection))
    : sectionText(config, selection) !== undefined;
  const selected = exists ? selection : "communication";
  const changed = changedSections(config, saved);
  const edit = (next: PromptConfig, note: PromptNote = {}) =>
    draft.edit(next, { from: note.from ?? draft.meta?.from, selection: note.selection ?? selected });
  const open = (name: string) => {
    select(name);
    setTab("edit");
  };
  const words: DraftWords = {
    merged: revision => t("promptConflict", { revision }),
    conflict: (revision, paths) =>
      t("promptConflictParts", {
        revision,
        parts: paths
          .map(([name, item]) =>
            sectionLabel(
              t,
              view,
              item === undefined
                ? name!
                : name === "skills"
                  ? `skill/${item}`
                  : name === "overrides"
                    ? `part/${item}`
                    : name!,
            ),
          )
          .join(t("listSeparator")),
      }),
    editing: [
      t("promptsDraftVersion", { revision: draft.revision }),
      t("promptChanges", { count: changed.length }),
      originText(t, view, draft.meta?.from),
    ]
      .filter(Boolean)
      .join(" · "),
  };
  const tabs = [
    { value: "edit" as const, label: t("promptViewEdit") },
    { value: "full" as const, label: t("promptViewFull") },
    { value: "history" as const, label: t("promptViewHistory") },
  ];
  const removed = view.defaultChanged.filter(item => item.removed).map(item => item.part);
  return (
    <div className="dt-form">
      <SegmentedTabs
        label={t("promptViews")}
        value={tab}
        onChange={setTab}
        items={tabs.map(item => ({ ...item, id: `dt-prompt-${item.value}`, panelId: "dt-prompt-view" }))}
      />
      {removed.length > 0 && <Hint>{t("promptRemovedParts", { parts: removed.join(t("listSeparator")) })}</Hint>}
      <div id="dt-prompt-view" role="tabpanel" aria-labelledby={`dt-prompt-${tab}`}>
        {tab === "edit" && (
          <PromptSections
            config={config}
            view={view}
            changed={changed}
            selected={selected}
            onSelect={select}
            onEdit={edit}
          />
        )}
        {tab === "full" && (
          <FullPrompt config={config} view={view} dirty={draft.dirty} revision={draft.revision} onEdit={open} />
        )}
        {tab === "history" && (
          <PromptHistory
            key={view.revision}
            view={view}
            from={draft.meta?.from}
            onLoad={(next, from) => edit(withOverrides(next, view.parts), { from })}
          />
        )}
      </div>
      <SaveBar
        {...draft}
        words={words}
        onSave={() => {
          void draft.submit();
        }}
        onDiscard={() => {
          draft.discard();
          reload().catch(failure => notify(errorText(failure)));
        }}
      />
    </div>
  );
}

function PromptSections({
  config,
  view,
  changed,
  selected,
  onSelect,
  onEdit,
}: {
  config: PromptConfig;
  view: PromptsView;
  changed: string[];
  selected: string;
  onSelect: (name: string) => void;
  onEdit: (next: PromptConfig, note?: PromptNote) => void;
}) {
  const { t } = usePanel();
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState(false);
  const item = (section: string, children: ReactNode) => (
    <SharedButton
      variant={section === selected ? "secondary" : "ghost"}
      size="content"
      key={section}
      type="button"
      className="flex-col items-stretch gap-1 p-2 text-left"
      aria-current={section === selected ? "true" : undefined}
      onClick={() => onSelect(section)}
    >
      {children}
    </SharedButton>
  );
  const unsaved = (section: string) =>
    changed.includes(section) && <span className="dt-changed-dot" aria-label={t("unsaved")} />;
  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!skillNameFree(name.trim(), config, view)) {
      setInvalid(true);
      return;
    }
    const section = `skill/${name.trim()}`;
    setName("");
    onEdit(withSection(config, section, ""), { selection: section });
    onSelect(section);
  };
  const part = isPart(selected) ? view.parts.find(item => item.key === partKey(selected)) : undefined;
  return (
    <div className="settings-layout dt-prompt">
      <nav className="settings-nav settings-nav-detailed dt-prompt-nav" aria-label={t("promptSections")}>
        <div className="section-label px-2">{t("promptTeamGroup")}</div>
        {view.sections.map(section =>
          item(
            section,
            <>
              <span>
                {sectionLabel(t, view, section)}
                {config[section] !== view.defaults[section] && (
                  <span className="settings-badge">{t("promptChanged")}</span>
                )}
                {unsaved(section)}
              </span>
              <small className="settings-row-description">{t(`promptPartHint.${section}`)}</small>
            </>,
          ),
        )}
        <div className="section-label px-2 pt-3">{t("promptBuiltInGroup")}</div>
        {view.parts.map(entry =>
          item(
            `part/${entry.key}`,
            <span>
              {sectionLabel(t, view, `part/${entry.key}`)}
              {config.overrides?.[entry.key] && <span className="settings-badge">{t("promptChanged")}</span>}
              {updated(config, entry) && <span className="settings-badge warn">{t("promptDefaultUpdated")}</span>}
              {unsaved(`part/${entry.key}`)}
            </span>,
          ),
        )}
        <div className="section-label px-2 pt-3">{t("promptSkillsGroup")}</div>
        {Object.keys(config.skills).map(skill =>
          item(
            `skill/${skill}`,
            <span>
              {sectionLabel(t, view, `skill/${skill}`)}
              {unsaved(`skill/${skill}`)}
            </span>,
          ),
        )}
        <form className="dt-add-skill" onSubmit={add}>
          <Input
            value={name}
            placeholder={t("promptSkillName")}
            aria-label={t("promptAddSkill")}
            spellCheck={false}
            onChange={event => {
              setName(event.target.value);
              setInvalid(false);
            }}
          />
          {invalid && (
            <p className="dt-error" role="alert">
              {t("promptSkillNameInvalid")}
            </p>
          )}
          <Button variant="ghost" size="sm" type="submit" icon={<Icon name="plus" />}>
            {t("promptAddSkillAction")}
          </Button>
        </form>
      </nav>
      {part ? (
        <BuiltInEditor config={config} view={view} part={part} onEdit={onEdit} />
      ) : (
        <TeamEditor config={config} view={view} selected={selected} onSelect={onSelect} onEdit={onEdit} />
      )}
    </div>
  );
}
/** Whether an override was edited from a built-in text that has changed since. */
const updated = (config: PromptConfig, part: BuiltInPart): boolean => {
  const override = config.overrides?.[part.key];
  return !!override?.base && override.base !== part.base;
};
function TeamEditor({
  config,
  view,
  selected,
  onSelect,
  onEdit,
}: {
  config: PromptConfig;
  view: PromptsView;
  selected: string;
  onSelect: (name: string) => void;
  onEdit: (next: PromptConfig, note?: PromptNote) => void;
}) {
  const { t } = usePanel();
  const text = sectionText(config, selected) ?? "";
  const fallback = sectionText(view.defaults, selected);
  return (
    <div className="dt-prompt-main">
      <div className="settings-group-heading flex-wrap">
        <h3>{sectionLabel(t, view, selected)}</h3>
        <span className="dt-actions">
          {isSkill(selected) ? (
            <Button
              variant="outline"
              size="sm"
              icon={<Icon name="trash" />}
              onClick={() => {
                onEdit(withoutSkill(config, selected), { selection: "communication" });
                onSelect("communication");
              }}
            >
              {t("remove")}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              icon={<Icon name="refresh" />}
              disabled={fallback === text}
              onClick={() => onEdit(withSection(config, selected, fallback ?? ""), { from: { reset: selected } })}
            >
              {t("promptResetSection")}
            </Button>
          )}
        </span>
      </div>
      <Hint>{t(isSkill(selected) ? "promptReadBy.skill" : "promptReadBy.both")}</Hint>
      <Textarea
        className="dt-mono min-h-90"
        spellCheck={false}
        aria-label={t("promptBody")}
        value={text}
        onChange={event => onEdit(withSection(config, selected, event.target.value))}
      />
    </div>
  );
}
/**
 * A built-in part: its text, the team's override or the built-in one, with a reset; a template says which placeholders it
 * keeps; an override whose built-in text changed since shows the change and offers to keep the team's text or take the new one.
 */
function BuiltInEditor({
  config,
  view,
  part,
  onEdit,
}: {
  config: PromptConfig;
  view: PromptsView;
  part: BuiltInPart;
  onEdit: (next: PromptConfig, note?: PromptNote) => void;
}) {
  const { t } = usePanel();
  const name = `part/${part.key}`;
  const reset = () => onEdit(withOverride(config, part, undefined), { from: { reset: name } });
  // The built-in text the override was edited from, when this installation kept that one.
  const base = config.overrides?.[part.key]?.base;
  const previous = view.defaultChanged.find(item => item.part === part.key && item.base === base)?.previous;
  const readBy = part.key.startsWith("skill/")
    ? "promptReadBy.skill"
    : part.roles.length > 1
      ? "promptReadBy.both"
      : (`promptReadBy.${part.roles[0]!}` as const);
  return (
    <div className="dt-prompt-main">
      <div className="settings-group-heading flex-wrap">
        <h3>{sectionLabel(t, view, name)}</h3>
        <span className="dt-actions">
          <Button
            variant="outline"
            size="sm"
            icon={<Icon name="refresh" />}
            disabled={!config.overrides?.[part.key]}
            onClick={reset}
          >
            {t("promptResetSection")}
          </Button>
        </span>
      </div>
      <Hint>{t(readBy)}</Hint>
      {part.placeholders && (
        <Hint>{t("promptTemplateHint", { placeholders: part.placeholders.join(t("listSeparator")) })}</Hint>
      )}
      {updated(config, part) && (
        <section className="dt-default-updated" aria-label={t("promptDefaultUpdated")}>
          <b>{t("promptDefaultUpdated")}</b>
          <Hint>{t("promptDefaultUpdatedHint")}</Hint>
          {previous !== undefined ? (
            <>
              <Hint>{t("promptDefaultUpdatedKnown")}</Hint>
              <Diff lines={lineDiff(previous, part.text)} />
            </>
          ) : (
            <>
              <Hint>{t("promptDefaultUpdatedUnknown")}</Hint>
              <Diff lines={lineDiff(partText(config, part), part.text)} />
            </>
          )}
          <span className="dt-actions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onEdit(withOverride(config, part, partText(config, part), true))}
            >
              {t("promptKeepMine")}
            </Button>
            <Button variant="outline" size="sm" onClick={reset}>
              {t("promptTakeDefault")}
            </Button>
          </span>
        </section>
      )}
      <Textarea
        className="dt-mono min-h-90"
        spellCheck={false}
        aria-label={t("promptBody")}
        value={partText(config, part)}
        onChange={event => onEdit(withOverride(config, part, event.target.value))}
      />
    </div>
  );
}
