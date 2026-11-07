// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/draft.tsx.
import type { T } from './text.ts'
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const LIST_KEYS = ['id', 'chatId']
const named = (list: unknown[], field: string) =>
  list.every(item => isRecord(item) && typeof item[field] === 'string') && new Set(list.map(item => (item as Record<string,
    unknown>)[field])).size === list.length
/**
 * Three-way merge between `base`, local `mine`, and remote `theirs`.
 * Merges objects by key and arrays of keyed records (`id` or `chatId`) by element: a key or element removed by one side is
 * deleted if the other side left it unchanged; a removal against a modification keeps `mine` and is recorded in `conflicts`.
 */
export function merge3(base: unknown, mine: unknown, theirs: unknown, conflicts: string[][] = [], path: string[] = []): unknown {
  if (same(mine, base) || same(mine, theirs)) return theirs
  if (same(theirs, base)) return mine
  if (Array.isArray(mine) && Array.isArray(theirs) && (base === undefined || Array.isArray(base))) {
    const lists = [base ?? [], mine, theirs]
    const field = LIST_KEYS.find(name => lists.every(list => named(list, name)))
    if (field) return mergeList(lists, field, conflicts, path)
  }
  if (!isRecord(base) || !isRecord(mine) || !isRecord(theirs)) { conflicts.push(path); return mine }
  const merged: Record<string, unknown> = {}
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
    const value = merge3(base[key], mine[key], theirs[key], conflicts, [...path, key])
    if (value !== undefined) merged[key] = value
  }
  return merged
}
function mergeList([base, mine, theirs]: unknown[][], field: string, conflicts: string[][], path: string[]): unknown[] {
  const name = (item: unknown) => String((item as Record<string, unknown>)[field])
  const [before, ours, others] = [base!, mine!, theirs!].map(list => new Map(list.map(item => [name(item), item])))
  const order = theirs!.map(name)
  mine!.forEach((item, index) => {
    if (order.includes(name(item))) return
    const previous = mine!.slice(0, index).map(name).reverse().find(key => order.includes(key))
    order.splice(previous === undefined ? 0 : order.indexOf(previous) + 1, 0, name(item))
  })
  return order.flatMap(key => {
    const value = merge3(before!.get(key), ours!.get(key), others!.get(key), conflicts, [...path, key])
    return value === undefined ? [] : [value]
  })
}

export interface Stored<V, M> { base: V; value: V; revision: number; meta?: M | undefined }

export type DraftNotice = { kind: 'restored' | 'rebasing' } | { kind: 'merged'; revision: number }
  | { kind: 'conflict'; revision: number; paths: string[][] } | { kind: 'invalid'; fields: string[] }
  | { kind: 'failed' | 'unstored'; error: string }
const FAILURES: ReadonlySet<DraftNotice['kind']> = new Set(['conflict', 'invalid', 'failed', 'unstored'])
export interface DraftState<V, M> {
  phase: 'clean' | 'editing' | 'saving' | 'awaitingRevision'
  draft?: Stored<V, M> | undefined
  sent?: { value: V; revision: number; restarting: boolean } | undefined
  seen?: number | undefined
  notice?: DraftNotice | undefined
}
export type DraftAction<V, M> = { type: 'edit'; value: V; meta: M | undefined; saved: V; revision: number | undefined }
  | { type: 'discard' | 'submit' } | { type: 'saved'; revision: number; restarting: boolean } | { type: 'refused'; notice: DraftNotice }
  | { type: 'revisionArrived'; saved: V; revision: number }
/**
 * State machine for a settings draft.
 * Holds submitted values in `awaitingRevision` until the polled revision catches up, and rebases active edits onto newer remote revisions via `merge3`.
 */
export function draftReducer<V, M>(state: DraftState<V, M>, action: DraftAction<V, M>): DraftState<V, M> {
  const { phase, draft, seen } = state
  switch (action.type) {
    case 'edit': {
      if (phase === 'saving' || phase === 'awaitingRevision') return state
      if (same(action.value, action.saved)) return { phase: 'clean', seen }
      const notice = state.notice && FAILURES.has(state.notice.kind) ? state.notice : undefined
      return { phase: 'editing', seen, notice, draft: { base: draft?.base ?? action.saved, value: action.value,
        revision: draft?.revision ?? action.revision ?? 0, ...action.meta === undefined ? {} : { meta: action.meta } } }
    }
    case 'discard': return phase === 'saving' || phase === 'awaitingRevision' ? state : { phase: 'clean', seen }
    case 'submit': return phase === 'editing' ? { ...state, phase: 'saving' } : state
    case 'saved': return phase === 'saving' && draft ? { phase: 'awaitingRevision', seen,
      sent: { value: draft.value, revision: action.revision, restarting: action.restarting } } : state
    case 'refused': return { ...state, phase: phase === 'saving' ? 'editing' : phase, notice: action.notice }
    case 'revisionArrived': {
      // Defer rebasing while a save is running; its completion will either advance to `awaitingRevision` or reload and merge.
      if (phase === 'saving') return state
      const { revision, saved } = action
      if (state.sent) return revision >= state.sent.revision ? { phase: 'clean', seen: revision } : { ...state, seen: revision }
      if (!draft || draft.revision === revision) return { ...state, seen: revision }
      const paths: string[][] = []
      const value = merge3(draft.base, draft.value, saved, paths) as V
      if (same(value, saved)) return { phase: 'clean', seen: revision }
      return { phase: 'editing', seen: revision, draft: { ...draft, base: saved, value, revision },
        notice: paths.length ? { kind: 'conflict', revision, paths } : { kind: 'merged', revision } }
    }
  }
}
export interface DraftWords {
  merged?: ((revision: number) => string) | undefined
  conflict?: ((revision: number, paths: string[][]) => string) | undefined
  editing?: string | undefined
}
export function saveBarText(t: T, { phase, sent, notice }: DraftState<unknown, unknown>,
  words: DraftWords = {}): { error?: string | undefined; status: string } {
  switch (notice?.kind) {
    case 'conflict': return { error: words.conflict?.(notice.revision, notice.paths) ?? t('saveConflict'), status: '' }
    case 'invalid': return { error: t('invalidSettings', { fields: notice.fields.join(t('listSeparator')) }), status: '' }
    case 'failed': return { error: notice.error, status: '' }
    case 'unstored': return { error: t('draftFailed', { error: notice.error }), status: '' }
    case 'merged': return { status: words.merged?.(notice.revision) ?? t('saveMerged') }
    case 'rebasing': return { status: t('saveRebasing') }
  }
  if (phase === 'awaitingRevision') return { status: t(sent?.restarting ? 'savedRestarting' : 'saved') }
  return { status: phase === 'clean' ? t('saved') : words.editing ?? t(notice?.kind === 'restored' ? 'draftRestored' : 'draftKept') }
}
