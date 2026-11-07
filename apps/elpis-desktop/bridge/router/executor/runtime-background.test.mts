import { it } from 'node:test'
import assert from 'node:assert/strict'
import { RuntimeBackground } from './runtime-background.mts'
import { ElpisAdapter } from './adapters.mts'
import { killJobs, stopBackground, untilQuiet } from './background.mts'
import type { Agent, Context } from './runtime.mts'
import { FakeServer } from './fixtures.test.mts'

it('keeps an idle worker busy for its terminals and stops its descendants without touching another worker', async t => {
  // Runtime waits normally have an open app-server socket; keep the fake boundary alive while a wait is pending.
  const guard = setTimeout(() => {}, 5000); t.after(() => clearTimeout(guard))
  const server = new FakeServer(), adapter = new ElpisAdapter(server.connect)
  const worker = await adapter.open({ cwd: '/project', name: 'Worker', model: null }), child = await adapter.open({ cwd: '/project', name: 'Child', model: null }), other = await adapter.open({ cwd: '/project', name: 'Other', model: null })
  server.parents.set(child.threadId, worker.threadId)
  await adapter.send(other.threadId, 'other-work', 'Work', null)
  server.jobs.set(worker.threadId, [{ id: 'owned', label: 'server' }]); server.jobs.set(child.threadId, [{ id: 'child-job', label: 'compiler' }]); server.jobs.set(other.threadId, [{ id: 'unrelated', label: 'editor' }])
  assert.deepEqual((await adapter.background(worker.threadId)).children, [{ id: child.threadId }])
  const errors: unknown[] = [], background = new RuntimeBackground(id => id === 'worker-one' ? { adapter, threadId: worker.threadId } : undefined, error => errors.push(error))
  t.after(() => { background.dispose(); adapter.close() })
  const agent: Agent = { id: 'worker-one', status: 'idle', inbox: { remove: () => {} }, session: { snapshotEvents: () => [] }, cancel: () => {}, whenIdle: async () => {} }
  const context: Context = { agents: new Map([[agent.id, agent]]), jobs: background.jobs, subagents: background.subagents, refresh: id => background.refresh(id), on: () => () => {}, subprocess: { spawn: () => { throw new Error('No subprocess expected') } } }
  const stop = new AbortController(), quiet = untilQuiet(context, agent, stop.signal)
  stop.abort(); assert.equal(await quiet, false)
  await stopBackground(context, agent.id, 'Assignment ended')
  assert.deepEqual(server.jobs.get(worker.threadId), []); assert.deepEqual(server.jobs.get(child.threadId), [])
  assert.equal((await adapter.read(child.threadId)).activeTurn, null)
  assert.ok((await adapter.read(other.threadId)).activeTurn); assert.equal(server.jobs.get(other.threadId)?.length, 1)
  assert.deepEqual(errors, [])
})

it('surfaces a failed process termination and still stops the other owned process', async t => {
  const guard = setTimeout(() => {}, 5000); t.after(() => clearTimeout(guard))
  const server = new FakeServer(), adapter = new ElpisAdapter(server.connect)
  const worker = await adapter.open({ cwd: '/project', name: 'Worker', model: null })
  server.jobs.set(worker.threadId, [{ id: 'bad', label: 'server' }, { id: 'good', label: 'compiler' }])
  server.failure = (method, params) => { if (method === 'thread/backgroundTerminals/terminate' && params.processId === 'bad') { server.jobs.set(worker.threadId, server.jobs.get(worker.threadId)!.filter(job => job.id !== 'bad')); return new Error('termination failed') }; return undefined }
  const background = new RuntimeBackground(() => ({ adapter, threadId: worker.threadId }), () => {})
  t.after(() => { background.dispose(); adapter.close() })
  const context: Context = { jobs: background.jobs, refresh: id => background.refresh(id), agents: new Map(), on: () => () => {}, subprocess: { spawn: () => { throw new Error('No subprocess expected') } } }
  await assert.rejects(killJobs(context, 'worker-one', 'stop'), AggregateError)
  assert.deepEqual(server.jobs.get(worker.threadId), [])
})
