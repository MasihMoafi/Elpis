// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/client/draft.tsx.
/**
 * Optimistic settings draft state with sessionStorage persistence and three-way rebase against concurrent saves.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, type FormEvent } from 'react'
import { ApiError } from './api.ts'
import { usePanel } from './provider.tsx'
import { errorText } from './text.ts'
import { Button } from './controls.tsx'
import { SettingsActions, SettingsNotice } from '@/components/settings/rows'

import { draftReducer, saveBarText, type DraftState, type DraftWords, type Stored } from './draft-state'
function read<V, M>(key: string | undefined): Stored<V, M> | undefined {
  if (!key) return undefined
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Partial<Stored<V, M>> | null
    // Drop drafts without `base` (stored by older versions) because they cannot be three-way merged.
    return stored && 'base' in stored && 'value' in stored && Number.isInteger(stored.revision) ? stored as Stored<V, M> : undefined
  } catch (error) { void error /* An unreadable draft is dropped; the saved value stays authoritative. */; return undefined }
}

export interface DraftOptions<V> {
  key?: string | undefined
  saved: V
  revision: number | undefined
  save: (value: V, revision: number, base: V) => Promise<{ revision: number; restarting?: boolean | undefined }>
  reload: () => Promise<unknown>
}
/** Manage a settings draft, persisting unsaved edits in `sessionStorage` and rebasing them when newer server revisions arrive. */
export function useDraft<V, M = undefined>({ key, saved, revision, save, reload }: DraftOptions<V>) {
  const { restart } = usePanel()
  const [state, dispatch] = useReducer(draftReducer<V, M>, undefined, () => {
    const stored = read<V, M>(key)
    const initial: DraftState<V, M> = stored ? { phase: 'editing', draft: stored, notice: { kind: 'restored' } } : { phase: 'clean' }
    return revision === undefined ? initial : draftReducer(initial, { type: 'revisionArrived', saved, revision })
  })
  if (state.phase !== 'saving' && revision !== undefined && revision !== state.seen) dispatch({ type: 'revisionArrived', saved, revision })
  useEffect(() => {
    if (!key) return
    try { if (state.draft) sessionStorage.setItem(key, JSON.stringify(state.draft)); else sessionStorage.removeItem(key) }
    catch (failure) { dispatch({ type: 'refused', notice: { kind: 'unstored', error: errorText(failure) } }) }
  }, [key, state.draft])
  const failed = (failure: unknown) => dispatch({ type: 'refused', notice: { kind: 'failed', error: errorText(failure) } })
  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    const { draft } = state
    if (state.phase !== 'editing' || !draft) return
    dispatch({ type: 'submit' })
    let result: { revision: number; restarting?: boolean | undefined }
    try {
      result = await save(draft.value, draft.revision, draft.base)
    } catch (failure) {
      const fields = failure instanceof ApiError ? failure.issues.map(issue => issue.path) : []
      if (failure instanceof ApiError && failure.status === 409) {
        await reload().then(() => dispatch({ type: 'refused', notice: { kind: 'rebasing' } }), failed)
      } else dispatch({ type: 'refused', notice: fields.length ? { kind: 'invalid', fields } : { kind: 'failed',
        error: errorText(failure) } })
      return
    }
    dispatch({ type: 'saved', revision: result.revision, restarting: !!result.restarting })
    if (result.restarting) restart(); else await reload().catch(failed)
  }
  return { state, value: state.sent?.value ?? state.draft?.value ?? saved, meta: state.draft?.meta,
    revision: state.draft?.revision ?? revision ?? 0, dirty: state.draft !== undefined,
    busy: state.phase === 'saving' || state.phase === 'awaitingRevision', submit,
    edit: (value: V, meta?: M) => dispatch({ type: 'edit', value, meta, saved, revision }), discard: () => dispatch({ type: 'discard' }) }
}

/** Sticky save/discard bar for a settings block; transfers focus back to its parent block when hidden so keyboard navigation does not reset. */
export function SaveBar({ state, dirty, busy, words, status, onDiscard, onSave }: {
  state: DraftState<unknown, unknown>; dirty: boolean; busy: boolean; words?: DraftWords | undefined; status?: string | undefined
  onDiscard: () => void; onSave?: (() => void) | undefined
}) {
  const { t } = usePanel()
  const line = saveBarText(t, state, words)
  const shown = dirty || busy || !!line.error
  const bar = useRef<HTMLDivElement>(null)
  const block = useRef<HTMLElement | null>(null)
  const focused = useRef(false)
  useLayoutEffect(() => {
    if (shown) { block.current = bar.current?.parentElement ?? null; return }
    const lost = !document.activeElement || document.activeElement === document.body
    if (focused.current && block.current && lost) { block.current.tabIndex = -1; block.current.focus({ preventScroll: true }) }
    focused.current = false
  }, [shown])
  if (!shown) return null
  const leave = (next: Element | null) => { if (next && !bar.current?.contains(next)) focused.current = false }
  return <div ref={bar} className="dt-savebar" onFocus={() => { focused.current = true }}
    onBlur={event => leave(event.relatedTarget as Element | null)}>
    <SettingsActions feedback={<SettingsNotice tone={line.error ? 'alert' : 'status'}>{line.error || status || line.status}</SettingsNotice>}>
    <Button variant="ghost" size="sm" disabled={!dirty || busy} onClick={onDiscard}>{t('discard')}</Button>
    <Button variant="primary" size="sm" disabled={!dirty || busy} {...onSave ? { onClick: onSave } : { type: 'submit' as const }}>
      {t('save')}
    </Button>
    </SettingsActions>
  </div>
}
