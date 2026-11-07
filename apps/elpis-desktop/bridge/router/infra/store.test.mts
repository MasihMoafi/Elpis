// Ported from dsh-superagent (MIT), tests/store.spec.ts and tests/runtime-concurrency.spec.ts
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RouterStore } from './store.mts'
import type { Thread } from '../core/index.mts'

it('persists domain state, rolls back nested writes, and excludes a second owner', () => {
  const home = mkdtempSync(join(tmpdir(), 'router-store-'))
  const thread: Thread = { key: 'chat:one', ref: { source: 'chat', id: 'one' }, createdAt: '', subscriptions: [], correlated: [], pending: ['event'], meta: {} }
  try {
    const store = new RouterStore(home)
    try {
      store.threads.save(thread)
      assert.throws(() => new RouterStore(home))
      assert.throws(() => store.atomic(() => { store.threads.save({ ...thread, pending: [] }); throw new Error('rollback') }))
      assert.deepEqual(store.threads.active(), [thread])
      assert.equal(statSync(join(home, 'router', 'orchestrator.sqlite')).mode & 0o777, 0o600)
    } finally { store.close() }
    const reopened = new RouterStore(home)
    try { assert.deepEqual(reopened.threads.get(thread.key), thread) } finally { reopened.close() }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

it('keeps an accepted ticket and its subscription across a reopen', async () => {
  const { Engine } = await import('../core/index.mts')
  const home = mkdtempSync(join(tmpdir(), 'router-engine-'))
  try {
    const store = new RouterStore(home)
    let ticketId = ''
    try {
      const engine = new Engine({
        repo: store,
        scope: { scope: () => ({ listened: true, observed: false }) },
        policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }),
        assessor: { request: () => {} },
        executor: { start: () => {}, deliver: () => {}, stop: () => {} },
        outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
      })
      engine.receive({ id: 'one', source: 'chat', threads: [{ source: 'chat', id: 'one' }], actor: { source: 'chat', id: 'alice' }, human: true, at: '2026-11-07T00:00:00Z', text: 'Fix it', meta: {} })
      const decision = engine.decide('one', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
      assert.ok(decision.ticketId)
      ticketId = decision.ticketId
    } finally { store.close() }
    const reopened = new RouterStore(home)
    try {
      assert.equal(reopened.tickets.get(ticketId)?.title, 'Fix')
      assert.deepEqual(reopened.threads.get('chat:one')?.subscriptions, [ticketId])
    } finally { reopened.close() }
  } finally { rmSync(home, { recursive: true, force: true }) }
})
