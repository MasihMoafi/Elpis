// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/navigation.ts.
/** Open a native session only after its catalog lookup succeeds. */
export interface SessionCatalog { list: { getSnapshot(): { phase: string; byId: Record<string, unknown> } }; refresh(): Promise<void> }

/**
 * Thrown by `openKnownSession` when the host Session catalog is not ready or does not list the target Session.
 * The management panel catches it to display a localized error message.
 */
export class SessionNavigationError extends Error {
  readonly code: 'not-ready' | 'not-listed'
  constructor(code: SessionNavigationError['code']) { super(code); this.code = code }
}

/** Select `id` in the workspace once the catalog lists it, unless aborted first. */
export async function openKnownSession(sessions: SessionCatalog, id: string, open: (id: string) => void, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  if (sessions.list.getSnapshot().phase !== 'ready' || !sessions.list.getSnapshot().byId[id]) await sessions.refresh()
  if (signal.aborted) return false
  const list = sessions.list.getSnapshot()
  if (list.phase !== 'ready') throw new SessionNavigationError('not-ready')
  if (!list.byId[id]) throw new SessionNavigationError('not-listed')
  open(id)
  return true
}
