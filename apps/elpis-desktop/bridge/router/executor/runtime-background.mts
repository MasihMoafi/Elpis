/** Maps the runtime's owned terminals and descendants onto the source Executor's background-work contract. */
import type { Jobs, Subagents } from './background.mts'
import type { RuntimeAdapter } from './adapters.mts'

interface Owner { adapter: RuntimeAdapter; threadId: string }
type Job = { id: string; owner: string; status: string; label: string }
export class RuntimeBackground {
  private readonly owner: (id: string) => Owner | undefined
  private readonly jobsByOwner = new Map<string, Map<string, Job>>()
  private readonly children = new Map<string, { id: string }[]>()
  private readonly listeners = new Map<string, Set<(event: { type: string }) => void>>()
  private readonly polls = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly lifetime = new AbortController()
  private readonly error: (error: unknown) => void
  constructor(owner: (id: string) => Owner | undefined, onError: (error: unknown) => void) { this.owner = owner; this.error = onError }
  async refresh(id: string): Promise<void> {
    const owner = this.owner(id)
    if (!owner || this.lifetime.signal.aborted) return
    const work = await owner.adapter.background(owner.threadId)
    const previous = this.jobsByOwner.get(id) ?? new Map<string, Job>()
    const live = new Set(work.jobs.map(job => job.id))
    let ended = false
    for (const job of previous.values()) if (job.status === 'running' && !live.has(job.id)) { job.status = 'ended'; ended = true }
    for (const job of work.jobs) previous.set(job.id, { ...job, owner: id, status: 'running' })
    this.jobsByOwner.set(id, previous); this.children.set(id, work.children)
    if (ended) for (const listener of this.listeners.get(id) ?? []) listener({ type: 'settled' })
  }
  private poll(id: string): void {
    if (this.polls.has(id) || this.lifetime.signal.aborted || !this.listeners.get(id)?.size) return
    const timer = setTimeout(() => {
      this.polls.delete(id)
      void this.refresh(id).catch(this.error).finally(() => this.poll(id))
    }, 1000)
    timer.unref(); this.polls.set(id, timer)
  }
  private async pause(signal: AbortSignal = this.lifetime.signal): Promise<void> {
    if (signal.aborted || this.lifetime.signal.aborted) return
    await new Promise<void>(resolve => {
      const both = AbortSignal.any([signal, this.lifetime.signal])
      const done = () => { clearTimeout(timer); both.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, 250)
      timer.unref(); both.addEventListener('abort', done, { once: true })
      if (both.aborted) done()
    })
  }
  readonly jobs: Jobs = {
    list: caller => [...this.jobsByOwner.get(caller)?.values() ?? []],
    wait: async (jobId, timeout, caller, signal) => {
      const deadline = Date.now() + timeout
      for (;;) {
        await this.refresh(caller)
        const job = this.jobsByOwner.get(caller)?.get(jobId)
        if (!job || job.status !== 'running' || Date.now() >= deadline || signal?.aborted || this.lifetime.signal.aborted) return { status: job?.status ?? 'ended' }
        await this.pause(signal)
      }
    },
    kill: async (jobId, caller) => {
      const owner = this.owner(caller)
      if (!owner || !this.jobsByOwner.get(caller)?.has(jobId)) throw new Error('The background process does not belong to this worker')
      await owner.adapter.killJob(owner.threadId, jobId); await this.refresh(caller)
    },
    events: { subscribe: ({ owner }, listener) => {
      const listeners = this.listeners.get(owner) ?? new Set()
      listeners.add(listener); this.listeners.set(owner, listeners); this.poll(owner)
      return () => { listeners.delete(listener); if (!listeners.size) { clearTimeout(this.polls.get(owner)); this.polls.delete(owner) } }
    } },
  }
  readonly subagents: Subagents = {
    listChildren: async id => { await this.refresh(id); return this.children.get(id) ?? [] },
    waitForChildren: async agent => {
      await this.refresh(agent.id)
      if (!this.children.get(agent.id)?.length) return false
      while (this.children.get(agent.id)?.length && !this.lifetime.signal.aborted) { await this.pause(); await this.refresh(agent.id) }
      return !this.lifetime.signal.aborted
    },
    drainChildren: async (agent, ids) => {
      const owner = this.owner(agent.id)
      if (!owner) return
      const results = await Promise.allSettled(ids.map(async id => {
        const child = await owner.adapter.read(id)
        if (child.activeTurn) await owner.adapter.stop(id, child.activeTurn)
        const work = await owner.adapter.background(id)
        await Promise.all(work.jobs.map(job => owner.adapter.killJob(id, job.id)))
      }))
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (failures.length) throw new AggregateError(failures, 'Stopping worker descendants failed')
    },
  }
  dispose(): void { this.lifetime.abort(); for (const timer of this.polls.values()) clearTimeout(timer); this.polls.clear(); this.listeners.clear() }
}
