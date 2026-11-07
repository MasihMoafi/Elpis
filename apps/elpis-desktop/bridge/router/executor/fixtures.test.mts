import { object, type Connection } from './adapters.mts'
/** Protocol fixture: owns runtime history independently of the executor's receipts; never calls a model. */
export class FakeServer {
  readonly calls: { method: string; params: Record<string, unknown> }[] = []
  readonly threads = new Map<string, { model: string; turns: { id: string; status: string; items: object[] }[] }>()
  readonly connections = new Set<Connection>()
  readonly jobs = new Map<string, { id: string; label: string }[]>()
  readonly parents = new Map<string, string>()
  failure: ((method: string, params: Record<string, unknown>) => unknown) | undefined
  hold: ((method: string, params: Record<string, unknown>) => Promise<void>) | undefined
  private seq = 0
  connect = (): Connection => {
    let closed = false
    const listeners = new Set<(message: unknown) => void>(), closers = new Set<(why: string) => void>()
    const connection: Connection = {
      ready: Promise.resolve(), get closed() { return closed }, listeners,
      call: async (method, raw) => {
        const params = object(raw)
        this.calls.push({ method, params })
        await this.hold?.(method, params)
        const failure = this.failure?.(method, params)
        if (failure) throw failure
        if (method === 'config/read') return { config: { mcp_servers: { personal: {}, approved: {} } } }
        if (method === 'thread/start') {
          const id = `thread-${++this.seq}`
          this.threads.set(id, { model: typeof params.model === 'string' ? params.model : 'default', turns: [] })
          return { thread: { id }, model: params.model ?? 'default' }
        }
        if (method === 'thread/name/set') return {}
        if (method === 'thread/list') return { data: [...this.parents].flatMap(([id, parent]) => parent === params.ancestorThreadId ? [{ id, status: { type: this.threads.get(id)?.turns.some(turn => turn.status === 'inProgress') ? 'active' : 'idle' } }] : []), nextCursor: null }
        const threadId = String(params.threadId), thread = this.threads.get(threadId)
        if (!thread) throw Object.assign(new Error('Thread not found'), { code: -32600 })
        if (method === 'thread/resume' || method === 'thread/read') return { thread: { id: threadId, model: thread.model, turns: thread.turns } }
        if (method === 'thread/turns/list') return { data: thread.turns, nextCursor: null }
        if (method === 'thread/backgroundTerminals/list') return { data: (this.jobs.get(threadId) ?? []).map(job => ({ processId: job.id, command: job.label })), nextCursor: null }
        if (method === 'thread/backgroundTerminals/terminate') {
          const jobs = this.jobs.get(threadId) ?? [], selected = jobs.find(job => job.id === params.processId)
          this.jobs.set(threadId, jobs.filter(job => job !== selected)); return { terminated: !!selected }
        }
        if (method === 'turn/start' || method === 'turn/steer') {
          const turn = method === 'turn/start' ? { id: `turn-${++this.seq}`, status: 'inProgress', items: [] as object[] } : thread.turns.find(turn => turn.id === params.expectedTurnId)
          if (!turn || turn.status !== 'inProgress') throw Object.assign(new Error('no active turn to steer'), { code: -32600 })
          turn.items.push({ type: 'userMessage', content: params.input })
          if (method === 'turn/start') thread.turns.push(turn)
          this.emit(threadId, 'turn/started', { turn })
          return { turn, turnId: turn.id }
        }
        if (method === 'turn/interrupt') { this.finish(threadId, 'interrupted'); return {} }
        throw new Error(`Unexpected method ${method}`)
      },
      onClose: listener => closers.add(listener),
      close: () => { closed = true; this.connections.delete(connection); for (const close of closers) close('fixture closed') },
    }
    this.connections.add(connection)
    return connection
  }
  emit(threadId: string, method: string, params: object): void {
    for (const conn of this.connections) for (const listener of conn.listeners) listener({ method, params: { threadId, ...params } })
  }
  finish(threadId: string, status = 'completed', text = 'Done'): void {
    const turn = this.threads.get(threadId)?.turns.findLast(turn => turn.status === 'inProgress')
    if (!turn) return
    turn.status = status
    this.emit(threadId, 'item/completed', { item: { type: 'agentMessage', text } })
    this.emit(threadId, 'turn/completed', { turn })
  }
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
export async function waitFor(check: () => void): Promise<void> {
  const { setImmediate } = await import('node:timers/promises')
  let error: unknown
  for (let attempt = 0; attempt < 100; attempt++) { try { check(); return } catch (failure) { error = failure; await setImmediate() } }
  throw error
}
