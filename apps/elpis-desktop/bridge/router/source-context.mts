// Adapted from dsh-superagent (MIT), src/app/source-context.ts.
import { threadKey, type Engine } from './core/index.mts'
import type { ExecutorStore } from './executor/store.mts'
import type { Commands } from './infra/commands.mts'
import type { Deployment } from './infra/types.mts'
import type { SourceContext } from './sources/host.mts'
import type { SourceRegistry } from './sources/registry.mts'
import type { Outbox } from './outbox.mts'

const factsOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

export function sourceContext(options: { store: ExecutorStore; engine: Engine; sources: SourceRegistry; commands: Commands; deployment: Deployment; outbox: Outbox; closing: () => boolean }, kind: { kind: string; health: readonly string[] }): SourceContext {
  const { store, engine, sources } = options, entries = sources.healthEntries(kind.health)
  const change = (key: string, update: (thread: NonNullable<ReturnType<typeof store.threads.get>>) => void) => store.atomic(() => {
    const thread = store.threads.get(key)
    if (thread) { update(thread); store.threads.save(thread) }
  })
  return {
    deployment: options.deployment, commands: options.commands, ready: Promise.resolve(), configured: () => !options.closing(),
    config: <C extends Record<string, unknown>>(id: string) => { const instance = sources.instance<C>(id); return instance?.enabled ? instance.config : undefined },
    receive: trigger => { if (options.closing()) throw new Error('Mother agent is stopping'); return engine.receive(trigger) },
    atomic: work => store.atomic(work), state: store.state,
    threads: {
      get: key => store.threads.get(key),
      subscribed: source => store.threads.list().filter(thread => thread.ref.source === source && thread.subscriptions.length > 0),
      describe: (key, description) => change(key, thread => {
        if (description.label !== undefined) thread.meta.label = description.label
        if (description.url !== undefined) thread.meta.url = description.url
        const facts = { ...factsOf(thread.meta.facts) }
        for (const [name, value] of Object.entries(description.facts ?? {})) { if (value === null) delete facts[name]; else facts[name] = value }
        thread.meta.facts = facts
      }),
      patch: (key, meta) => change(key, thread => { for (const [name, value] of Object.entries(meta)) { if (value === undefined) delete thread.meta[name]; else thread.meta[name] = value } }),
    },
    tickets: { get: id => store.tickets.get(id), open: () => store.tickets.open(),
      bindThread: (id, thread, own) => { engine.bindThread(id, thread, own) }, threadClosed: (thread, outcome, at) => engine.threadClosed(thread, outcome, at) },
    triggers: { get: id => store.triggers.get(id), latest: key => {
      const row = store.db.prepare('SELECT value FROM trigger ORDER BY rowid DESC').all().find(row => {
        const value: { threads: { source: string; id: string }[] } = JSON.parse(String(row.value))
        return value.threads.some(thread => threadKey(thread) === key)
      })
      return row ? store.triggers.get((JSON.parse(String(row.value)) as { id: string }).id) : undefined
    } },
    notify: message => options.outbox.send(message),
    report: (entry, value) => { if (!kind.health.includes(entry)) throw new Error(`Undeclared health entry: ${entry}`); entries.get(entry)?.set(value) },
  }
}
