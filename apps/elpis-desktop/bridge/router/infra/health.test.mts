// Ported from dsh-superagent (MIT), tests/registry.spec.ts
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { HealthBoard } from './health.mts'

it('gives each health entry one owner, and releases it for a new owner', () => {
  const board = new HealthBoard()
  const first = board.claim('source', { state: 'starting', detail: '' })
  assert.throws(() => board.claim('source'), /another part/)
  first.release()
  const second = board.claim('source', { state: 'ready', detail: 'ready' })
  first.set({ state: 'error', detail: 'stale owner' })
  assert.equal(second.get()?.state, 'ready')
  second.release()
  assert.equal(board.all.source, undefined)
})
