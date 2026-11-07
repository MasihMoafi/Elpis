import { Button as SharedButton } from '@/components/ui/button'
// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/settings-kit.tsx.
/** Shared settings context, block draft hook, form controls, Source schema field renderer, and configuration history. */
import { cloneElement, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement,
  type ReactNode } from 'react'
import { OptionSelect } from '@/components/ui/option-select'
import type { ApiResponse } from '../../bridge/router/app/api.mts'
import type { FieldSpec, Localized } from '../../bridge/router/sources/kind.mts'
import { usePoll, type HistoryView, type Settings, type SettingsView, type SourceView } from './api.ts'
import { Button, DisclosureRow, Icon, InfoTip, Input, SegmentedControl, Switch } from './controls.tsx'
import { useDraft } from './draft.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { errorText, localized, valueLabel, valueText, when, type T } from './text.ts'
import { Hint, LoadState } from './widgets.tsx'

/** Parse a numeric input string, returning `null` when empty so the server rejects blank required numbers instead of coercing to 0. */
export const numberOf = (text: string): number | null => text.trim() ? Number(text) : null
interface SettingsData { settings: SettingsView; reload: () => Promise<void> }
const SettingsContext = createContext<SettingsData | undefined>(undefined)
export function useSettings(): SettingsData {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('A settings block rendered outside the settings')
  return value
}
export function SettingsProvider({ children }: { children: ReactNode }) {
  const { call } = usePanel()
  const { restarts } = usePanelData()
  const { data, error, reload } = usePoll(() => call('GET settings'), [call, restarts])
  if (!data) return <LoadState error={error} loading />
  return <SettingsContext.Provider value={{ settings: data, reload }}>
    {error && <LoadState error={error} loading={false} />}
    {children}
  </SettingsContext.Provider>
}
export function useBlockDraft<V>(block: string, saved: V, revision: number, toValue: (draft: V) => unknown = draft => draft) {
  const { t, call, notify } = usePanel()
  const { state } = usePanelData()
  const { reload } = useSettings()
  return useDraft({ key: `mother/draft/${state?.masterId ?? ''}/${block}`, saved, revision, reload, save: async (value, from) => {
    const result = await call('PUT settings/:block', { block, body: { value: toValue(value), revision: from } })
    notify(t(result.restarting ? 'savedRestarting' : 'saved'))
    return result
  } })
}

/** Fieldset wrapper that restores focus to the previously active input after a save completes and re-enables the form. */
export function Fields({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const set = useRef<HTMLFieldSetElement>(null)
  const focused = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (disabled) focused.current = active instanceof HTMLElement && set.current?.contains(active) ? active : null
    else if (focused.current && (!active
      || active === document.body)) { focused.current.focus({ preventScroll: true }); focused.current = null }
  }, [disabled])
  return <fieldset ref={set} className="dt-fieldset" disabled={disabled}>{children}</fieldset>
}
export function Field({ label, hint, note,
  children }: { label: string; hint?: string | undefined; note?: ReactNode | undefined; children: ReactElement<{ id?: string | undefined }> }) {
  const id = useId()
  return <div className="dt-field">
    <span className="dt-field-head"><label htmlFor={id}>{label}</label>{hint && <InfoTip text={hint} />}</span>{cloneElement(children,
      { id })}{note && <small>{note}</small>}
  </div>
}
function SwitchRow({ label, hint, checked,
  onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (next: boolean) => void }) {
  return <div className="dt-switch-row">
    <div className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</div><Switch checked={checked} onChange={onChange}
      label={label} />
  </div>
}
type RoleModel = Settings['eval']['model']
export function ModelField({ id, value, onChange }: { id: string; value: RoleModel; onChange: (next: RoleModel) => void }) {
  const { t, call } = usePanel()
  const [catalog, setCatalog] = useState<ApiResponse<'GET models'>>()
  const [error, setError] = useState<string>()
  useEffect(() => { call('GET models').then(setCatalog, failure => setError(errorText(failure))) }, [call])
  const current = { provider: value?.provider ?? '', model: value?.model ?? '', effort: value?.reasoningEffort ?? '' }
  const set = (next: Partial<typeof current>) => {
    const { provider, model, effort } = { ...current, ...next }
    onChange(provider.trim() || model.trim() || effort.trim() ? { provider, model, ...effort ? { reasoningEffort: effort } : {} } : null)
  }
  const models = catalog?.groups.find(group => group.id === current.provider.trim())?.models ?? []
  const fallback = catalog?.default
  const input = (name: keyof typeof current, label: string, placeholder: string) => <Field label={label}>
    <Input list={`${id}-${name}s`} spellCheck={false} placeholder={placeholder} value={current[name]}
      onChange={event => set({ [name]: event.target.value })} />
  </Field>
  return <div className="dt-model">
    <Hint>{fallback ? t('defaultModel', { model: `${fallback.provider} / ${fallback.model}${fallback.reasoningEffort
      ? ` · ${fallback.reasoningEffort}` : ''}` }) : t('defaultModelUnavailable')}</Hint>
    {error && <p className="dt-error">{t('modelCatalogError', { error })}</p>}
    <div className="dt-grid3">
      {input('provider', t('modelProvider'), t('modelInherit'))}{input('model', t('modelName'), t('modelInherit'))}{input('effort',
        t('modelEffort'), t('modelEffortDefault'))}
    </div>
    <datalist id={`${id}-providers`}>{catalog?.groups.map(group => <option key={group.id}
      value={group.id}>{group.name}</option>)}</datalist>
    <datalist id={`${id}-models`}>{models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}</datalist>
    <datalist id={`${id}-efforts`}>
      {(models.find(model => model.id === current.model.trim())?.reasoning?.efforts ?? []).map(effort => <option key={effort.id}
        value={effort.id}>{effort.name}</option>)}
    </datalist>
  </div>
}

type HistoryChange = NonNullable<HistoryView['items'][number]['changes']>[number]
function changeText(t: T, change: HistoryChange, sources: SourceView[]): string {
  const source = sources.find(item => item.id === change.source)
  const field = (change.part ? source?.policy?.fields : source?.fields)?.find(item => item.key === change.field)
  const shown = (value: unknown) => value === undefined || value === null || value === '' ? t('unsetValue') : typeof value === 'boolean'
    ? t(value ? 'yes' : 'no')
    : change.code === 'mode' ? valueLabel(t, 'mode', valueText(value)) : valueText(value)
  return t(`change.${change.code}`,
    { items: (change.items ?? []).map(item => source?.labels[item] ?? item).join(t('listSeparator')),
    from: shown(change.from), to: shown(change.to), name: change.name ?? '', source: source ? localized(t, source.title)
      : change.source ?? '',
    field: field ? localized(t, field.label) : change.field ?? '' })
}
/**
 * Collapsible revision history for the specified settings blocks, optionally including all Policy-changing saves.
 * Revisions saved before per-block tracking existed have no `block` and appear under `policy`.
 */
export function ConfigHistory({ blocks, versions, focus }: { blocks: string[]; versions?: boolean | undefined; focus?: string | undefined }) {
  const { t, call } = usePanel()
  const { settings } = useSettings()
  const { sources } = settings
  const [open, setOpen] = useState(!!focus)
  const [data, setData] = useState<HistoryView>()
  const [error, setError] = useState<string>()
  const revisions = JSON.stringify([Object.values(settings.blocks).map(block => block.revision), sources.map(source => source.revision)])
  useEffect(() => { if (open) call('GET policy/history').then(setData, failure => setError(errorText(failure))) }, [open, call, revisions])
  const listed = (block: string | undefined) => block ? blocks.some(item => item === block || (item.endsWith(':')
    && block.startsWith(item))) : blocks.includes('policy')
  const items = data?.items.filter(item => (versions && item.policyChanged) || listed(item.block)) ?? []
  // Match the oldest save that produced the focused Policy version (where that version originated).
  const target = focus ? items.filter(item => item.policyChanged && item.policyVersion.startsWith(focus)).at(-1) : undefined
  const scroll = (element: HTMLLIElement | null) => { if (element
    && !element.dataset.scrolled) { element.dataset.scrolled = '1'; element.scrollIntoView?.({ block: 'center' }) } }
  return <DisclosureRow icon={<Icon name="history" />} title={t('configHistory')} open={open} onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      {error && <p className="dt-error">{error}</p>}
      {data && <>
        <Hint>{t('historyIntro')}</Hint>
        {focus && !target && <Hint>{t('policyVersionUnrecorded', { version: focus.slice(0, 8) })}</Hint>}
        {items.length ? <ul className="dt-timeline">{items.map(item => <li key={item.revision} className={item === target
          ? 'dt-event dt-highlight' : 'dt-event'}
          ref={item === target ? scroll : undefined}>
          <div className="dt-row-title">{t('historyItem', { revision: item.revision, source: valueLabel(t, 'historySource',
            item.source) })}</div>
          <div className="dt-event-foot">{when(item.savedAt, t('lang'))}{item.policyChanged && <> · {t('historyPolicyChanged',
            { version: item.policyVersion.slice(0, 8) })}</>}</div>
          {item.changes === null ? <Hint>{t('historyNoBaseline')}</Hint> : item.changes.length
            ? <ul className="dt-changes">{item.changes.map((change, index) => <li key={index}>{changeText(t, change, sources)}</li>)}</ul>
              : <Hint>{t('historyNoChanges')}</Hint>}
          {item.notified.length > 0 && <Hint>{t('historyNotified', { count: item.notified.length,
            titles: item.notified.map(ticket => ticket.title).join(t('listSeparator')) })}</Hint>}
        </li>)}</ul> : <Hint>{t('historyEmpty')}</Hint>}
      </>}
    </div>
  </DisclosureRow>
}

type Row = Record<string, string>
type Column = Extract<FieldSpec, { type: 'rows' }>['columns'][number]
const ROWS_SHOWN = 6
const byName = ([, a]: [string, string], [, b]: [string, string]) => a.localeCompare(b)
function RowsField({ field, value, saved, onChange, labels, refreshLabels }: {
  field: Extract<FieldSpec, { type: 'rows' }>; value: unknown; saved: unknown; onChange: (next: unknown) => void; labels: Record<string,
    string>
  refreshLabels: (() => Promise<string[]>) | undefined
}) {
  const { t, notify } = usePanel()
  const [open, setOpen] = useState(false)
  const refresh = useAction(async () => {
    try {
      const added = await refreshLabels!()
      notify(added.length ? t('labelsAdded', { names: added.join(t('listSeparator')) }) : t('labelsCurrent'))
    } catch (failure) { notify(t('labelsFailed', { error: errorText(failure) })) }
  })
  const label = localized(t, field.label), hint = localized(t, field.hint)
  const rows = Array.isArray(value) ? value as Row[] : []
  const set = (index: number, row: Row) => onChange(rows.map((item, position) => position === index ? row : item))
  const key = field.columns[0]!
  const savedKeys = new Set((Array.isArray(saved) ? saved as Row[] : []).map(row => row[key.key]))
  const choose = key.type === 'text' && key.choose && Object.keys(labels).length ? localized(t, key.choose) : ''
  // Exclude options already selected in another row.
  const choices = (id: string) => Object.entries(labels).filter(([option]) => option === id
    || !rows.some(other => other[key.key] === option)).sort(byName)
  const blank = Object.fromEntries(field.columns.map(column => [column.key, column.type === 'select' ? column.options[0]!.value : '']))
  // Summarize a row by its second column only when that column is free text (e.g., a display name), not a select option.
  const named = field.columns[1]?.type === 'text' ? field.columns[1] : undefined
  const rowName = (row: Row) => (named && row[named.key]) || labels[row[key.key] ?? ''] || row[key.key] || ''
  const cell = (row: Row, index: number, column: Column) => {
    const id = row[key.key] ?? '', change = (next: string) => set(index, { ...row, [column.key]: next })
    if (column === key && (savedKeys.has(id) || (!choose && labels[id]))) {
      return <span key={column.key} className={labels[id] ? 'dt-row-label' : 'dt-row-label dt-mono'} title={id}>{labels[id] ?? id}</span>
    }
    if (column === key && choose) {
      return <OptionSelect key={column.key} className="dt-select" aria-label={choose} required value={id}
        onChange={event => change(event.target.value)}>
        <option value="" disabled>{choose}</option>
        {choices(id).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
      </OptionSelect>
    }
    if (column.type === 'select') {
      return <OptionSelect key={column.key} className="dt-select" aria-label={localized(t, column.label)} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)}>
        {column.options.map(option => <option key={option.value} value={option.value}>{localized(t, option.label)}</option>)}
      </OptionSelect>
    }
    return <Input key={column.key} className={column.optional ? undefined : 'dt-mono'} aria-label={localized(t, column.label)}
      placeholder={localized(t, column.label)}
      required={!column.optional} pattern={column.pattern} spellCheck={false} value={row[column.key] ?? ''}
        onChange={event => change(event.target.value)} />
  }
  return <div className="dt-field">
    <div className="dt-subhead">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}<span className="dt-count">{rows.length || ''}</span></span>
      <span className="dt-subhead-actions">
        {key.type === 'text' && key.refresh && refreshLabels && <Button variant="ghost" size="sm" className={refresh.busy ? 'dt-btn-busy'
          : undefined} icon={<Icon name="refresh" />}
          disabled={refresh.busy} aria-busy={refresh.busy} onClick={() => { void refresh.run() }}>{localized(t, key.refresh)}</Button>}
        <Button variant="ghost" size="sm" icon={<Icon name="plus" />} onClick={() => { setOpen(true); onChange([...rows,
          blank]) }}>{t('addRow')}</Button>
      </span>
    </div>
    {rows.length > ROWS_SHOWN && <SharedButton variant="ghost" size="sm" type="button" className="dt-textlink dt-rows-summary" aria-expanded={open}
      onClick={() => setOpen(!open)}>
      {open ? t('collapse') : rows.map(rowName).join(t('listSeparator'))}
    </SharedButton>}
    {(rows.length <= ROWS_SHOWN || open) && <ul className="dt-rows"
      style={{ ['--dt-columns' as string]: field.columns.length }}>{rows.map((row, index) => <li key={index} className="dt-rows-item">
      {field.columns.map(column => cell(row, index, column))}
      <Button variant="ghost" size="sm" icon={<Icon name="trash" />} aria-label={t('removeRow', { name: labels[row[key.key] ?? '']
        || row[key.key] || label })}
        onClick={() => onChange(rows.filter((_, position) => position !== index))} />
    </li>)}</ul>}
  </div>
}
export function SourceField({ field, value, saved, fact, onChange, labels, refreshLabels }: {
  field: FieldSpec; value: unknown; saved: unknown; fact: Localized | string | undefined; onChange: (next: unknown) => void
  labels: Record<string, string>
  refreshLabels?: (() => Promise<string[]>) | undefined
}) {
  const { t, navigate } = usePanel()
  const label = localized(t, field.label), hint = localized(t, field.hint)
  switch (field.type) {
    case 'switch': return <SwitchRow label={label} hint={hint} checked={value === true} onChange={onChange} />
    case 'select': return <Field label={label} hint={hint}>
      <SegmentedControl className="dt-segmented dt-field-segmented" label={label} value={valueText(value ?? field.options[0]!.value)}
        options={field.options.map(option => ({ value: option.value, label: localized(t, option.label) }))} onChange={onChange} />
    </Field>
    case 'number': return <Field label={label} hint={hint}>
      <Input type="number" min={field.min} max={field.max} required value={valueText(value)}
        onChange={event => onChange(event.target.value === '' ? '' : Number(event.target.value))} />
    </Field>
    case 'text': return <Field label={label} hint={hint} note={localized(t, fact)}>
      {field.choose && Object.keys(labels).length
        ? <OptionSelect className="dt-select" value={valueText(value)} onChange={event => onChange(event.target.value)}>
          <option value="">{localized(t, field.choose)}</option>
          {value && !labels[valueText(value)] ? <option value={valueText(value)}>{valueText(value)}</option> : null}
          {Object.entries(labels).sort(byName).map(([option, name]) => <option key={option} value={option}>{name}</option>)}
        </OptionSelect>
        : <Input value={valueText(value)} readOnly={field.readonly} pattern={field.pattern} spellCheck={false}
          onChange={event => onChange(event.target.value)} />}
    </Field>
    case 'fact': return <div className="dt-field">
      <span className="dt-field-head">{label}{hint && <InfoTip text={hint} />}</span>
      <span className="dt-mono">{localized(t, fact) || t('empty')}</span>
      {field.settings && <small>
        <SharedButton variant="ghost" size="sm" type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute(field.settings!))}>{t(`openSettingsOf.${field.settings}`)}</SharedButton>
      </small>}
    </div>
    case 'rows': return <RowsField field={field} value={value} saved={saved} onChange={onChange} labels={labels}
      refreshLabels={refreshLabels} />
  }
}
