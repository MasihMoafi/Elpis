import { it } from 'node:test';
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine, latestAssignment, type Trigger, type Ticket } from '../core/index.mts';
import { ExecutorService } from './service.mts';
import { ExecutorStore } from './store.mts';
import { ElpisAdapter } from './adapters.mts';

import { FakeServer } from './fixtures.mts';

it('reopens SQLite, resumes the same worker after restart, delivers a pending correction once and relays reports', async () => {
  const home = mkdtempSync(join(tmpdir(), 'router-restart-')), server = new FakeServer()
  let store: ExecutorStore | undefined, service: ExecutorService | undefined
  const create = () => {
    const repo = new ExecutorStore(home)
    const engine: Engine = new Engine({ repo, scope: { scope: () => ({ listened: true, observed: true }) },
      policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }),
      assessor: { request: () => {} }, executor: { start: (...args) => workers.executor.start(...args), stop: (...args) => workers.executor.stop(...args), deliver: (...args) => workers.executor.deliver(...args) },
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} }, prepareTicket: (...args) => workers.executor.prepare(...args) })
    const workers: ExecutorService = new ExecutorService({ store: repo, stateDir: join(home, 'router'), engine: () => engine, adapters: [new ElpisAdapter(server.connect)],
      subprocess: { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} }) }, paused: () => false, mainSessionId: 'mother' })
    // The fixture binds its main chat just as the router application does.
    server.threads.set('mother', server.threads.get('mother') ?? { model: 'default', turns: [] })
    return { repo, workers, engine }
  }
  const trigger = (id: string): Trigger => ({ id, source: 'chat', threads: [{ source: 'chat', id: 'goal' }], actor: { source: 'chat', id: 'alice' }, human: true, at: new Date().toISOString(), text: id, meta: {} })
  try {
    let run = create(); store = run.repo; service = run.workers
    await service.sessions.adopt('mother', 'elpis', 'mother'); await service.start()
    run.engine.receive(trigger('goal'))
    const decision = run.engine.decide('goal', { kind: 'accept', name: 'fix-work', title: 'Fix', scope: 'small', reason: 'asked' })
    await service.pump(); assert.ok(decision.ticketId)
    const id = decision.ticketId, workerId = `worker-${id}`, first = latestAssignment(store.tickets.get(id)!)!
    const threadId = (store.session(workerId) as { threadId: string }).threadId
    // Persist a correction without dispatching its effect, then simulate the host disappearing.
    run.engine.receive(trigger('correction'))
    await service.shutdown(); store.close(); store = undefined; service = undefined
    run = create(); store = run.repo; service = run.workers
    await service.sessions.adopt('mother', 'elpis', 'mother'); await service.start(); await service.pump()
    assert.equal((store.session(workerId) as { threadId: string }).threadId, threadId)
    const recovered = store.tickets.get(id)!
    assert.notEqual(latestAssignment(recovered)?.id, first.id)
    assert.equal(latestAssignment(recovered)?.state, 'running')
    assert.equal(recovered.undelivered.length, 0)
    assert.equal(server.calls.filter(call => call.method === 'thread/start').length, 1)
    const messages = server.threads.get(threadId)!.turns.flatMap(turn => turn.items).map(item => JSON.stringify(item))
    assert.equal(messages.filter(text => text.includes('correction')).length, 1)
    assert.ok(messages.some(text => text.includes('Do not repeat an already completed external operation')))
    service.report(workerId, { state: 'progress', summary: 'halfway' }); await service.pump()
    assert.equal(server.threads.get('mother')!.turns.length, 0)
    service.report(workerId, { state: 'blocked', summary: 'Need a choice', question: 'Which color?' }); await service.pump()
    assert.ok(JSON.stringify(server.threads.get('mother')!.turns).includes('Which color?'))
    assert.throws(() => service!.report('unrelated', { state: 'ready', summary: 'fake' }), /attached worker/)
  } finally { if (service) await service.shutdown(); store?.close(); rmSync(home, { recursive: true, force: true }) }
  assert.equal(server.connections.size, 0)
})

it('applies the proactive mandate to the runtime instructions before the worker starts', async () => {
  const home = mkdtempSync(join(tmpdir(), 'router-mandate-')), server = new FakeServer(), store = new ExecutorStore(home)
  const ticket: Ticket = { id: 'proactive', title: 'Small fix', decisionId: 'accepted', channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '',
    origin: { triggerId: 'source', triggerIds: ['source'] }, mandate: { strength: 'inferred', policyVersion: 'v1', basis: { via: 'listed', rules: ['typos'] }, actor: { source: 'chat', id: 'alice' }, scope: 'typos only' } }
  store.tickets.save(ticket)
  const service = new ExecutorService({ store, stateDir: join(home, 'router'), engine: () => { throw new Error('No domain mutation expected') }, adapters: [new ElpisAdapter(server.connect)],
    subprocess: { spawn: () => { throw new Error('No subprocess expected') } }, paused: () => true, instructions: () => 'Project worker instructions' })
  try {
    await service.sessions.ensure('worker-proactive', '/project', ticket.title, 'worker')
    const create = server.calls.find(call => call.method === 'thread/start')!.params
    assert.match(String(create.developerInstructions), /Project worker instructions/)
    assert.match(String(create.developerInstructions), /limited proactive authorization/)
    assert.match(String(create.developerInstructions), /do not expand scope/)
  } finally { await service.shutdown(); store.close(); rmSync(home, { recursive: true, force: true }) }
})
