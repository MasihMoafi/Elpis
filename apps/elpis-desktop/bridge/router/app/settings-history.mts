// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/settings-history.ts.
/** Computes structured settings diffs across saved revisions for display in the management panel. */
import type { FieldSpec } from '../sources/kind.mts'
import type { SourceRegistry } from '../sources/registry.mts'
import { KV } from '../sources/kv.mts'
import type { Store, SettingsVersion } from './store.mts'

type SourceSettings = SettingsVersion['settings']['sources'][string]
/** Change codes localized by the web panel as `change.<code>`. */
export type SettingsChangeCode = 'ruleAdded' | 'ruleRenamed' | 'ruleInstruction' | 'ruleEnabled' | 'ruleDisabled' | 'ruleRemoved'
  | 'sourceEnabled' | 'sourceDisabled' | 'sourceField' | 'sourceRowsAdded' | 'sourceRowsRemoved' | 'sourceRowsChanged' | 'sourceAdmission'
  | 'mode' | 'timeout' | 'evalModel' | 'executorModel' | 'maxWorkers' | 'paused' | 'resumed' | 'executionDirectory' | 'prepareCommand'
  | 'blockedCommands'
/** A single settings diff entry rendered by the panel using `change.<code>` and field labels from the Source listing. */
export interface SettingsChange {
  code: SettingsChangeCode; items?: string[]; from?: string | number | boolean; to?: string | number | boolean; name?: string; source?: string
  field?: string; part?: true
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function fieldChanges(id: string, fields: readonly FieldSpec[], a: Record<string, unknown>, b: Record<string, unknown>, part?: true): SettingsChange[] {
  const changes: SettingsChange[] = []
  const at = { source: id, ...part ? { part } : {} }
  for (const field of fields) {
    const from = a[field.key], to = b[field.key]
    if (same(from, to)) continue
    if (field.type === 'rows') {
      const rowKey = field.columns[0]!.key
      const rows = (value: unknown) => new Map((Array.isArray(value) ? value as Record<string, unknown>[] : []).map(row => [String(row[rowKey]), row]))
      // Prefer the second column (human-readable label) over the row key when naming changed rows.
      const label = (row: Record<string, unknown> | undefined, item: string) => { const value = field.columns[1] && row?.[field.columns[1].key]; return typeof value === 'string' && value ? value : item }
      const old = rows(from), next = rows(to)
      const added = [...next.keys()].filter(item => !old.has(item)).map(item => label(next.get(item), item)), removed = [...old.keys()].filter(item => !next.has(item)).map(item => label(old.get(item), item))
      const changed = [...next.keys()].filter(item => old.has(item) && !same(old.get(item), next.get(item))).map(item => label(next.get(item), item))
      if (added.length) changes.push({ code: 'sourceRowsAdded', ...at, field: field.key, items: added })
      if (removed.length) changes.push({ code: 'sourceRowsRemoved', ...at, field: field.key, items: removed })
      if (changed.length) changes.push({ code: 'sourceRowsChanged', ...at, field: field.key, items: changed })
    } else changes.push({ code: 'sourceField', ...at, field: field.key, from: from as string | number | boolean, to: to as string | number | boolean })
  }
  return changes
}
function sourceChanges(id: string, before: SourceSettings | undefined, after: SourceSettings | undefined, sources: SourceRegistry): SettingsChange[] {
  const kind = sources.kind(id)
  const changes: SettingsChange[] = []
  if ((before?.enabled ?? true) !== (after?.enabled ?? true)) changes.push({ code: after?.enabled === false ? 'sourceDisabled' : 'sourceEnabled', source: id })
  const fill = (value: SourceSettings | undefined) => kind ? kind.schema.parse(value?.config ?? {}) : value?.config ?? {}
  return [...changes, ...fieldChanges(id, kind?.fields ?? [], fill(before), fill(after))]
}
function settingsChanges(before: SettingsVersion['settings'], after: SettingsVersion['settings'], sources: SourceRegistry): SettingsChange[] {
  const changes: SettingsChange[] = []
  for (const rule of after.policy.rules) {
    const old = before.policy.rules.find(item => item.id === rule.id)
    if (!old) { changes.push({ code: 'ruleAdded', name: rule.name }); continue }
    if (old.name !== rule.name) changes.push({ code: 'ruleRenamed', from: old.name, to: rule.name })
    if (old.instruction !== rule.instruction) changes.push({ code: 'ruleInstruction', name: rule.name })
    if (old.enabled !== rule.enabled) changes.push({ code: rule.enabled ? 'ruleEnabled' : 'ruleDisabled', name: rule.name })
  }
  for (const rule of before.policy.rules) if (!after.policy.rules.some(item => item.id === rule.id)) changes.push({ code: 'ruleRemoved', name: rule.name })
  for (const id of new Set([...Object.keys(before.policy.sources), ...Object.keys(after.policy.sources)])) {
    const policy = sources.kind(id)?.policy
    // Validate source-specific policy fields separately from the shared admission table.
    const fill = (value: Record<string, unknown> | undefined) => { const { admission: _admission, ...rest } = value ?? {}; return policy ? policy.schema.parse(rest) : rest }
    changes.push(...fieldChanges(id, policy?.fields ?? [], fill(before.policy.sources[id]), fill(after.policy.sources[id]), true))
    // Admission tables map receiving scopes rather than form fields, so summarize any table change as one entry per Source.
    if (JSON.stringify(before.policy.sources[id]?.admission ?? {}) !== JSON.stringify(after.policy.sources[id]?.admission ?? {})) changes.push({ code: 'sourceAdmission', source: id, part: true })
  }
  if (before.eval.mode !== after.eval.mode) changes.push({ code: 'mode', from: before.eval.mode, to: after.eval.mode })
  if (before.eval.timeoutSeconds !== after.eval.timeoutSeconds) changes.push({ code: 'timeout', from: before.eval.timeoutSeconds, to: after.eval.timeoutSeconds })
  if (!same(before.eval.model, after.eval.model)) changes.push({ code: 'evalModel' })
  if (!same(before.executor.model, after.executor.model)) changes.push({ code: 'executorModel' })
  if (before.executor.maxWorkers !== after.executor.maxWorkers) changes.push({ code: 'maxWorkers', from: before.executor.maxWorkers, to: after.executor.maxWorkers })
  if (before.paused !== after.paused) changes.push({ code: after.paused ? 'paused' : 'resumed' })
  if (before.executor.directory !== after.executor.directory) changes.push({ code: 'executionDirectory', from: before.executor.directory, to: after.executor.directory })
  if (before.executor.prepare !== after.executor.prepare) changes.push({ code: 'prepareCommand' })
  if (!same(before.executor.blockedCommands, after.executor.blockedCommands)) changes.push({ code: 'blockedCommands', from: before.executor.blockedCommands.join(' '), to: after.executor.blockedCommands.join(' ') })
  for (const id of new Set([...Object.keys(before.sources), ...Object.keys(after.sources)])) changes.push(...sourceChanges(id, before.sources[id], after.sources[id], sources))
  return changes
}
/** Compute changes between two revisions, returning null if a historical revision fails current source schema validation. */
function changesOf(before: SettingsVersion['settings'], after: SettingsVersion['settings'], sources: SourceRegistry): SettingsChange[] | null {
  try { return settingsChanges(before, after, sources) } catch { return null }
}
/** Return recent settings revisions newest-first with their computed diffs and notified tickets. */
export function policyHistory(store: Store, sources: SourceRegistry, policyVersionValue: string) {
  const versions = store.settingsHistory(30)
  return { current: store.get(KV.settings.revision) ?? 0, policyVersion: policyVersionValue,
    items: versions.map((version, index) => {
      const previous = versions[index + 1]
      return { revision: version.revision, savedAt: version.savedAt, source: version.source, block: version.block, policyVersion: version.policyVersion, policyChanged: version.policyChanged, notified: version.notified.map(id => ({ id, title: store.tickets.get(id)?.title ?? id })),
        changes: previous && previous.revision === version.revision - 1 ? changesOf(previous.settings, version.settings, sources) : null }
    }) }
}
export type HistoryView = ReturnType<typeof policyHistory>
