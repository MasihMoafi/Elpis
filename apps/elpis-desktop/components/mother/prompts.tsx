import { OptionSelect } from '@/components/ui/option-select'
import { Textarea } from '@/components/ui/textarea'
import { Button as SharedButton } from '@/components/ui/button'
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/prompts.tsx.
/** Prompts settings group: section/skill editor, full composed prompt preview with diffing, and revision history. */
import { Fragment, useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { ApiResponse } from '../../bridge/router/app/api.mts'
import type { PromptConfig, PromptsView } from './api.ts'
import { SaveBar, useDraft } from './draft.tsx'
import type { DraftWords } from './draft-state'
import { changedSections, isPart, isSkill, lineDiff, partKey, partText, partWith, sectionLabel, sectionText, skillNameFree, withOverride,
  withOverrides, withSection, withoutSkill, type BuiltInPart, type DiffLine } from './prompt-config.ts'
import { useAction, usePanel } from './provider.tsx'
import { errorText, valueLabel, when, type T } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'
import { Button, Icon, Input, SegmentedControl, SegmentedTabs } from './controls.tsx'

type Tab = 'edit' | 'full' | 'history'
type Origin = { revision: number } | 'defaults' | { reset: string }
interface PromptNote { from?: Origin | undefined; selection?: string | undefined }
const originText = (t: T, view: PromptsView, from: Origin | undefined): string | undefined => from === undefined ? undefined
  : from === 'defaults' ? t('promptDraftFromDefaults') : 'revision' in from ? t('promptDraftFromHistory', { revision: from.revision })
  : t('promptDraftSectionReset', { part: sectionLabel(t, view, from.reset) })

export function PromptsPage() {
  const { call } = usePanel()
  const [view, setView] = useState<PromptsView>()
  const [error, setError] = useState<Error>()
  const reload = useCallback(async () => { setView(await call('GET prompts')) }, [call])
  useEffect(() => { reload().catch(setError) }, [reload])
  return view ? <PromptsEditor view={view} reload={reload} /> : <LoadState loading error={error} />
}

function PromptsEditor({ view, reload }: { view: PromptsView; reload: () => Promise<void> }) {
  const { t, call, notify } = usePanel()
  const saved = withOverrides(view.current.config)
  const draft = useDraft<PromptConfig, PromptNote>({ key: `mother/prompts/${view.masterId}`, saved, revision: view.revision,
    reload,
    save: async (config, baseRevision) => {
      const result = await call('PUT prompts', { body: { config, baseRevision } })
      notify(t(result.context_delivery === 'pending' ? 'promptSavedPending' : 'saved'))
      return result
    } })
  const config = draft.value
  const [tab, setTab] = useState<Tab>('edit')
  const [selection, select] = useState(draft.meta?.selection ?? 'communication')
  // Fall back to the first section when the selected section (e.g., a skill removed by discard) is no longer in the draft.
  const exists = isPart(selection) ? view.parts.some(part => part.key === partKey(selection)) : sectionText(config, selection) !== undefined
  const selected = exists ? selection : 'communication'
  const changed = changedSections(config, saved)
  const edit = (next: PromptConfig, note: PromptNote = {}) => draft.edit(next, { from: note.from ?? draft.meta?.from,
    selection: note.selection ?? selected })
  const open = (name: string) => { select(name); setTab('edit') }
  const words: DraftWords = { merged: revision => t('promptConflict', { revision }),
    conflict: (revision, paths) => t('promptConflictParts', { revision, parts: paths.map(([name, item]) => sectionLabel(t, view,
      item === undefined ? name! : name === 'skills' ? `skill/${item}` : name === 'overrides' ? `part/${item}` : name!)).join(t('listSeparator')) }),
    editing: [t('promptsDraftVersion', { revision: draft.revision }), t('promptChanges', { count: changed.length }),
      originText(t, view, draft.meta?.from)].filter(Boolean).join(' · ') }
  const tabs = [{ value: 'edit' as const, label: t('promptViewEdit') }, { value: 'full' as const, label: t('promptViewFull') },
    { value: 'history' as const, label: t('promptViewHistory') }]
  const removed = view.defaultChanged.filter(item => item.removed).map(item => item.part)
  return <div className="dt-form">
    <SegmentedTabs label={t('promptViews')} value={tab} onChange={setTab}
      items={tabs.map(item => ({ ...item, id: `dt-prompt-${item.value}`, panelId: 'dt-prompt-view' }))} />
    {removed.length > 0 && <Hint>{t('promptRemovedParts', { parts: removed.join(t('listSeparator')) })}</Hint>}
    <div id="dt-prompt-view" role="tabpanel" aria-labelledby={`dt-prompt-${tab}`}>
    {tab === 'edit' && <PromptSections config={config} view={view} changed={changed} selected={selected} onSelect={select} onEdit={edit} />}
    {tab === 'full' && <FullPrompt config={config} view={view} dirty={draft.dirty} revision={draft.revision} onEdit={open} />}
    {tab === 'history' && <PromptHistory key={view.revision} view={view} from={draft.meta?.from}
      onLoad={(next, from) => edit(withOverrides(next, view.parts), { from })} />}
    </div>
    <SaveBar {...draft} words={words} onSave={() => { void draft.submit() }}
      onDiscard={() => { draft.discard(); reload().catch(failure => notify(errorText(failure))) }} />
  </div>
}

function PromptSections({ config, view, changed, selected, onSelect, onEdit }: {
  config: PromptConfig; view: PromptsView; changed: string[]; selected: string; onSelect: (name: string) => void
  onEdit: (next: PromptConfig, note?: PromptNote) => void
}) {
  const { t } = usePanel()
  const [name, setName] = useState('')
  const [invalid, setInvalid] = useState(false)
  const item = (section: string, children: ReactNode) => <SharedButton variant={section === selected ? 'secondary' : 'ghost'} size="content" key={section} type="button" className="flex-col items-stretch gap-1 p-2 text-left"
    aria-current={section === selected ? 'true' : undefined} onClick={() => onSelect(section)}>{children}</SharedButton>
  const unsaved = (section: string) => changed.includes(section) && <span className="dt-changed-dot" aria-label={t('unsaved')} />
  const add = (event: FormEvent) => {
    event.preventDefault()
    if (!skillNameFree(name.trim(), config, view)) { setInvalid(true); return }
    const section = `skill/${name.trim()}`
    setName('')
    onEdit(withSection(config, section, ''), { selection: section }); onSelect(section)
  }
  const part = isPart(selected) ? view.parts.find(item => item.key === partKey(selected)) : undefined
  return <div className="settings-layout dt-prompt">
    <nav className="settings-nav settings-nav-detailed dt-prompt-nav" aria-label={t('promptSections')}>
      <div className="section-label px-2">{t('promptTeamGroup')}</div>
      {view.sections.map(section => item(section, <>
        <span>{sectionLabel(t, view, section)}{config[section] !== view.defaults[section] && <span
          className="settings-badge">{t('promptChanged')}</span>}{unsaved(section)}</span><small className="settings-row-description">{t(`promptPartHint.${section}`)}</small>
      </>))}
      <div className="section-label px-2 pt-3">{t('promptBuiltInGroup')}</div>
      {view.parts.map(entry => item(`part/${entry.key}`, <span>{sectionLabel(t, view, `part/${entry.key}`)}
        {config.overrides?.[entry.key] && <span className="settings-badge">{t('promptChanged')}</span>}
        {updated(config, entry) && <span className="settings-badge warn">{t('promptDefaultUpdated')}</span>}
        {unsaved(`part/${entry.key}`)}</span>))}
      <div className="section-label px-2 pt-3">{t('promptSkillsGroup')}</div>
      {Object.keys(config.skills).map(skill => item(`skill/${skill}`, <span>{sectionLabel(t, view, `skill/${skill}`)}{unsaved(
        `skill/${skill}`)}</span>))}
      <form className="dt-add-skill" onSubmit={add}>
        <Input value={name} placeholder={t('promptSkillName')} aria-label={t('promptAddSkill')} spellCheck={false}
          onChange={event => { setName(event.target.value); setInvalid(false) }} />
        {invalid && <p className="dt-error" role="alert">{t('promptSkillNameInvalid')}</p>}
        <Button variant="ghost" size="sm" type="submit" icon={<Icon name="plus" />}>{t('promptAddSkillAction')}</Button>
      </form>
    </nav>
    {part ? <BuiltInEditor config={config} view={view} part={part} onEdit={onEdit} />
      : <TeamEditor config={config} view={view} selected={selected} onSelect={onSelect} onEdit={onEdit} />}
  </div>
}
/** Whether an override was edited from a built-in text that has changed since. */
const updated = (config: PromptConfig, part: BuiltInPart): boolean => {
  const override = config.overrides?.[part.key]
  return !!override?.base && override.base !== part.base
}
function TeamEditor({ config, view, selected, onSelect, onEdit }: {
  config: PromptConfig; view: PromptsView; selected: string; onSelect: (name: string) => void; onEdit: (next: PromptConfig, note?: PromptNote) => void
}) {
  const { t } = usePanel()
  const text = sectionText(config, selected) ?? ''
  const fallback = sectionText(view.defaults, selected)
  return <div className="dt-prompt-main">
    <div className="settings-group-heading flex-wrap"><h3>{sectionLabel(t, view, selected)}</h3>
      <span className="dt-actions">{isSkill(selected)
        ? <Button variant="outline" size="sm" icon={<Icon name="trash" />} onClick={() => { onEdit(withoutSkill(config, selected),
          { selection: 'communication' }); onSelect('communication') }}>{t('remove')}</Button>
        : <Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={fallback === text}
          onClick={() => onEdit(withSection(config, selected, fallback ?? ''), { from: { reset: selected } })}>
          {t('promptResetSection')}
        </Button>}
    </span></div>
    <Hint>{t(isSkill(selected) ? 'promptReadBy.skill' : 'promptReadBy.both')}</Hint>
    <Textarea className="dt-mono min-h-90" spellCheck={false} aria-label={t('promptBody')} value={text}
      onChange={event => onEdit(withSection(config, selected, event.target.value))} />
  </div>
}
/**
 * A built-in part: its text, the team's override or the built-in one, with a reset; a template says which placeholders it
 * keeps; an override whose built-in text changed since shows the change and offers to keep the team's text or take the new one.
 */
function BuiltInEditor({ config, view, part, onEdit }: {
  config: PromptConfig; view: PromptsView; part: BuiltInPart; onEdit: (next: PromptConfig, note?: PromptNote) => void
}) {
  const { t } = usePanel()
  const name = `part/${part.key}`
  const reset = () => onEdit(withOverride(config, part, undefined), { from: { reset: name } })
  // The built-in text the override was edited from, when this installation kept that one.
  const base = config.overrides?.[part.key]?.base
  const previous = view.defaultChanged.find(item => item.part === part.key && item.base === base)?.previous
  const readBy = part.key.startsWith('skill/') ? 'promptReadBy.skill' : part.roles.length > 1 ? 'promptReadBy.both'
    : `promptReadBy.${part.roles[0]!}` as const
  return <div className="dt-prompt-main">
    <div className="settings-group-heading flex-wrap"><h3>{sectionLabel(t, view, name)}</h3>
      <span className="dt-actions"><Button variant="outline" size="sm" icon={<Icon name="refresh" />} disabled={!config.overrides?.[part.key]}
        onClick={reset}>{t('promptResetSection')}</Button></span></div>
    <Hint>{t(readBy)}</Hint>
    {part.placeholders && <Hint>{t('promptTemplateHint', { placeholders: part.placeholders.join(t('listSeparator')) })}</Hint>}
    {updated(config, part) && <section className="dt-default-updated" aria-label={t('promptDefaultUpdated')}>
      <b>{t('promptDefaultUpdated')}</b>
      <Hint>{t('promptDefaultUpdatedHint')}</Hint>
      {previous !== undefined ? <><Hint>{t('promptDefaultUpdatedKnown')}</Hint><Diff lines={lineDiff(previous, part.text)} /></>
        : <><Hint>{t('promptDefaultUpdatedUnknown')}</Hint><Diff lines={lineDiff(partText(config, part), part.text)} /></>}
      <span className="dt-actions">
        <Button variant="outline" size="sm" onClick={() => onEdit(withOverride(config, part, partText(config, part), true))}>
          {t('promptKeepMine')}</Button>
        <Button variant="outline" size="sm" onClick={reset}>{t('promptTakeDefault')}</Button>
      </span>
    </section>}
    <Textarea className="dt-mono min-h-90" spellCheck={false} aria-label={t('promptBody')} value={partText(config, part)}
      onChange={event => onEdit(withOverride(config, part, event.target.value))} />
  </div>
}

type Preview = ApiResponse<'POST prompts/preview'>
type Target = 'orchestrator' | 'worker' | `skill/${string}`
const KIND_LABEL = { team: 'promptPartTeam', fixed: 'promptPartFixed', generated: 'promptPartGenerated' } as const
function FullPrompt({ config, view, dirty, revision, onEdit }: {
  config: PromptConfig; view: PromptsView; dirty: boolean; revision: number; onEdit: (name: string) => void
}) {
  const { t, call, notify } = usePanel()
  const [target, setTarget] = useState<Target>('orchestrator')
  const [compare, setCompare] = useState<'saved' | 'default'>(dirty ? 'saved' : 'default')
  // Keep the preview paired with the config it was composed from so diffs stay consistent until the next preview arrives.
  const [preview, setPreview] = useState<{ config: PromptConfig; value: Preview }>()
  const [error, setError] = useState<Error>()
  useEffect(() => {
    let active = true
    call('POST prompts/preview', { body: config }).then(value => { if (active) { setPreview({ config, value }); setError(undefined) } },
      (failure: Error) => { if (active) setError(failure) })
    return () => { active = false }
  }, [call, config])
  if (!preview || error) return <LoadState loading error={error} />
  const shown = dirty ? compare : 'default'
  // A built-in skill is a built-in part, by its key.
  const team = isSkill(target) && Object.hasOwn(preview.config.skills, target.slice(6))
  const parts: { name: string; kind: 'team' | 'fixed' | 'generated'; key?: string | undefined; heading?: string | undefined; text: string }[] = isSkill(target)
    ? [{ name: target, kind: team ? 'team' : 'fixed', ...team ? {} : { key: target }, text: preview.value.skills[target.slice(6)] ?? '' }]
    : preview.value.parts[target]
  const builtIn = (key: string) => view.parts.find(part => part.key === key)
  return <>
    <div className="dt-subhead">
      <OptionSelect className="w-auto" aria-label={t('promptPreviewTarget')} value={target}
        onChange={event => setTarget(event.target.value as Target)}>
        <option value="orchestrator">{valueLabel(t, 'promptRole', 'orchestrator')}</option>
        <option value="worker">{valueLabel(t, 'promptRole', 'worker')}</option>
        {Object.keys(preview.value.skills).map(name => <option key={name} value={`skill/${name}`}>{sectionLabel(t, view,
          `skill/${name}`)}</option>)}
      </OptionSelect>
      <Hint>{t('promptFullState', { count: parts.length, chars: parts.reduce((sum, part) => sum + part.text.length, 0),
        state: dirty ? t('promptPreviewDraft') : t('promptPreviewSaved', { revision }) })}</Hint>
      <SegmentedControl className="dt-compare" label={t('promptCompare')} value={shown} options={[...dirty
        ? [{ value: 'saved' as const, label: t('promptCompareSaved') }] : [], { value: 'default' as const,
          label: t('promptCompareDefault') }]} onChange={setCompare} />
      <Button variant="outline" size="sm" icon={<Icon name="copy" />} onClick={() => {
        void navigator.clipboard.writeText(parts.map(part => part.text).join('\n\n')).then(() => notify(t('copied')))
      }}>{t('promptCopyAll')}</Button>
    </div>
    {parts.map(part => {
      const { kind } = part
      const text = sectionText(preview.config, part.name) ?? ''
      const entry = part.key === undefined ? undefined : builtIn(part.key)
      // The text a part is compared with: a team section's, or a built-in part's, override or built-in text, in the saved
      // version or the defaults; a generated part holds data and is not compared.
      const from = (config: PromptConfig) => kind === 'team' ? partWith(part, sectionText(config, part.name) ?? '')
        : kind === 'fixed' && entry ? partText(config, entry) : undefined
      const base = from(shown === 'saved' ? view.current.config : view.defaults)
      const edited = kind === 'team' ? !isSkill(part.name) && text !== sectionText(view.defaults, part.name)
        : !!entry && !!preview.config.overrides?.[entry.key]
      // A generated part's template the draft changed shows filled, as it is not compared.
      const template = kind === 'generated' && !!entry
        && preview.config.overrides?.[entry.key]?.text !== view.current.config.overrides?.[entry.key]?.text
      return <section key={part.name} className="dt-preview-part" data-editable={kind === 'team' || entry !== undefined || undefined}>
        <div className="dt-preview-head"><b>{sectionLabel(t, view, entry ? `part/${entry.key}` : part.name)}</b><span>{t(KIND_LABEL[kind])}</span>
          {edited && <span className="settings-badge">{t('promptChanged')}</span>}
          {(kind === 'team' || entry) && <SharedButton variant="link" size="content" type="button" className="dt-textlink p-0 justify-start text-left"
            onClick={() => onEdit(entry ? `part/${entry.key}` : part.name)}>{t('promptEditSource')}</SharedButton>}
        </div>
        {/* When comparing against saved, show only changes from this draft and fold the parts it leaves as they were. */}
        {base !== undefined && base !== part.text ? <Diff lines={lineDiff(base, part.text)} />
          : shown === 'saved' && !template ? <Hint>{t(kind === 'generated' ? 'promptBuiltInFolded' : 'promptSameAsSaved')}</Hint>
          : <pre className="dt-pre">{part.text}</pre>}
      </section>
    })}
  </>
}
function Diff({ lines }: { lines: DiffLine[] }) {
  const { t } = usePanel()
  return <pre className="dt-pre">{lines.map((line, index) => <Fragment key={index}>{line.kind === 'fold'
    ? <><span className="dt-diff-fold">{t('promptSameLines', { count: line.count })}</span>{'\n'}</>
    : line.kind === 'ins' ? <ins>{`${line.text}\n`}</ins> : line.kind === 'del' ? <del>{`${line.text}\n`}</del>
    : `${line.text}\n`}</Fragment>)}</pre>
}

function PromptHistory({ view, from, onLoad }: {
  view: PromptsView; from: Origin | undefined; onLoad: (config: PromptConfig, from: Origin) => void
}) {
  const { t, call } = usePanel()
  const [older, setOlder] = useState<Pick<PromptsView, 'revisions' | 'next_offset'>>()
  const next = older ? older.next_offset : view.next_offset
  const more = useAction(async (offset: number) => {
    const page = await call('GET prompts', { query: { offset } })
    setOlder({ revisions: [...older?.revisions ?? [], ...page.revisions], next_offset: page.next_offset })
  })
  const load = useAction(async (revision: number) => {
    onLoad((await call('GET prompts', { query: { revision } })).current.config, { revision })
  })
  return <div className="dt-form">
    <Hint>{t('promptHistoryHint')}</Hint>
    <ul className="dt-list">{[...view.revisions, ...older?.revisions ?? []].map(version => <li key={version.revision} data-slot="settings-row" className="settings-row dt-row">
      <div className="settings-row-text dt-row-main">
        <div className="settings-row-title dt-row-title">{t('promptHistoryItem', { revision: version.revision, time: version.savedAt
          ? when(version.savedAt, t('lang')) : t('promptHistoryInitial'), source: valueLabel(t, 'historySource', version.source) })}</div>
        <div className="settings-row-description dt-row-meta">{version.changed.length ? t('promptHistoryChanged', { parts: version.changed.map(name =>
          sectionLabel(t, view, name)).join(t('listSeparator')) }) : t('promptHistoryNone')}</div>
      </div>
      <div className="dt-row-actions"><Button variant="outline" size="sm" icon={<Icon name="history" />}
        disabled={load.busy || (typeof from === 'object' && 'revision' in from && from.revision === version.revision)}
        onClick={() => { void load.run(version.revision) }}>{t('promptRestore')}</Button></div>
    </li>)}</ul>
    <div className="dt-actions">
      {next !== null && <Button variant="outline" size="sm" icon={<Icon name="chevron-down" />} disabled={more.busy}
        onClick={() => { void more.run(next) }}>{t('promptOlder')}</Button>}
      <Button variant="outline" size="sm" icon={<Icon name="refresh" />}
        onClick={() => onLoad(view.defaults, 'defaults')}>{t('promptDefaults')}</Button>
    </div>
    <div className="dt-field"><span>{t('promptSessions')}</span>
      {view.sessions.length ? <ul className="dt-changes dt-mono">{view.sessions.map(item => <li
        key={item.sessionId}>{t('promptSessionItem', { session: item.sessionId, revision: item.revision })}</li>)}</ul>
        : <Hint>{t('promptNoSessions')}</Hint>}
    </div>
  </div>
}
