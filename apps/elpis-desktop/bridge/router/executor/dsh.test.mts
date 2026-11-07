// Ported from dsh-superagent (MIT), tests/runtime-concurrency.spec.ts and tests/runtime.spec.ts
import { it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, latestAssignment, type Ticket, type Trigger } from '../core/index.mts'
import { HealthBoard } from '../infra/health.mts'
import { DshExecutor, WorkerSlots, mandateInstructions, ticketExecution, triggerMessage, inputMessage, transient, type ExecutorHost } from './dsh.mts'
import { Effects, Later } from './effects.mts'
import { ExecutorStore } from './store.mts'
import { Sessions } from './sessions.mts'
import { SettingsSchema, type Settings } from './settings.mts'
import { ElpisAdapter } from './adapters.mts'
import { FakeServer, deferred, waitFor } from './fixtures.test.mts'

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'router-executor-')), server = new FakeServer()
  let settings = SettingsSchema.parse({}), clock = Date.now(), paused = false, closing = false
  const store = new ExecutorStore(home, () => settings), board = new HealthBoard(), effects = new Effects(store, board, () => clock)
  const subprocess: ExecutorHost['context']['subprocess'] = { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: {} }) }
  const sessions = new Sessions({ store, subprocess, adapters: [new ElpisAdapter(server.connect)] })
  const relays: string[] = []
  effects.handle('relay', async payload => { relays.push(payload.text) })
  // Sessions uses the same durable queue, while the fixture consumes the main-session boundary without a model.
  sessions.relay = (id, text) => effects.enqueue('relay', id, { text })
  const lifetime = new AbortController()
  const engine = new Engine({ repo: store,
    scope: { scope: () => ({ listened: true, observed: true }) },
    policy: () => ({ version: 'v1', paused, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }),
    assessor: { request: () => {} }, executor: { start: (...args) => executor.start(...args), stop: (...args) => executor.stop(...args), deliver: (...args) => executor.deliver(...args) },
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} },
    prepareTicket: (...args) => executor.prepare(...args), now: () => new Date(clock++).toISOString(),
  })
  const host: ExecutorHost = { context: sessions, engine, store, effects, health: board.claim('worker'), machine: { stateDir: join(home, 'router') }, lifetime: lifetime.signal,
    sessions, closing: () => closing, paused: () => paused, environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined }
  const executor = new DshExecutor(host); executor.install(); effects.start()
  const trigger = (id: string, root = id, human = true): Trigger => ({ id, source: 'chat', threads: [{ source: 'chat', id: root }], actor: { source: 'chat', id: 'alice' }, human, at: new Date(clock++).toISOString(), text: `Request ${id}`, meta: {} })
  async function accept(id: string) {
    engine.receive(trigger(id)); const decision = engine.decide(id, { kind: 'accept', name: 'fix-work', title: 'Fix', scope: 'small fix', reason: 'asked' })
    await effects.idle()
    assert.ok(decision.ticketId)
    const ticket = store.tickets.get(decision.ticketId)!
    return { ticket, sessionId: `worker-${ticket.id}`, threadId: String((store.session(`worker-${ticket.id}`) as { threadId: string } | undefined)?.threadId ?? '') }
  }
  async function stop() {
    closing = true; await executor.shutdown(); executor.dispose(); sessions.dispose(); lifetime.abort(); await effects.drain(); store.close(); rmSync(home, { recursive: true, force: true })
  }
  return { home, server, store, effects, sessions, engine, executor, host, relays, trigger, accept, stop,
    configure: (change: Partial<Settings['executor']>) => { settings = { ...settings, executor: { ...settings.executor, ...change } } },
    pause: (value: boolean) => { paused = value }, advance: (ms = 6000) => { clock += ms } }
}
it('holds one slot per running or starting ticket and gives a person one extra slot', () => {
  const running = ['t1'], slots = new WorkerSlots(() => running, () => 3)
  slots.reserve('t2', 'launch'); slots.reserve('t3', 'wake')
  assert.equal(slots.used(), 3); assert.equal(slots.launches(), 1)
  assert.throws(() => slots.reserve('t4', 'wake'), Later)
  slots.reserve('t3', 'wake'); slots.reserve('t4', 'person')
  assert.equal(slots.used(), 4); assert.throws(() => slots.reserve('t5', 'person'), Later)
  slots.free('t3'); assert.equal(slots.used(), 3)
})
it('words an assignment and inferred authorization from the ticket alone', () => {
  const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy fixes', instruction: 'Fix typos only.' }] } })
  const ticket: Ticket = { id: 'ticket-0123456789abcdef', title: 'Fix', decisionId: 'd', channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'tr1', triggerIds: [] },
    mandate: { strength: 'inferred', policyVersion: 'v1', basis: { via: 'listed', rules: ['copy'] }, actor: { source: 'github', id: 'alice' }, scope: '' } }
  const execution = ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo' }, settings, '/state')
  assert.equal(execution.name, 'fix-typo-ticket-01234'); assert.equal(execution.directory, '/state/work/fix-typo-ticket-01234')
  assert.match(execution.assignment, /Scope: the typo/); assert.match(execution.assignment, /Copy fixes \(copy\): Fix typos only/)
  assert.ok(!execution.assignment.includes(mandateInstructions(ticket.mandate)))
  assert.equal(mandateInstructions({ strength: 'explicit' }), '')
  assert.throws(() => ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: '', reason: '', name: '../outside' }, settings, '/state'))
})
it('renders each Input inline, truncates long triggers, and ignores legacy reopen inputs', () => {
  const trigger: Trigger = { id: 'tr1', source: 'chat', threads: [{ source: 'chat', id: 'one' }], actor: { source: 'chat', id: 'alice' }, human: true, at: '', text: 'a'.repeat(700), meta: {} }
  const card = triggerMessage(trigger, { source_url: 'https://example.test' })
  assert.equal(card.text.length, 601); assert.equal(card.chars, 700); assert.equal(card.read, 'trigger/tr1')
  assert.deepEqual(JSON.parse(inputMessage({ id: 'i', kind: 'trigger', triggerId: 'tr1', at: '', context: true }, card)!), { ...card, context: true })
  assert.equal(inputMessage({ id: 'i', kind: 'text', text: 'Correction', at: '' }), 'Correction')
  assert.match(inputMessage({ id: 'i', kind: 'note', text: 'Fact', at: '' })!, /for context only: Fact/)
  assert.match(inputMessage({ id: 'i', kind: 'resumed', triggerId: 'tr1', at: '' })!, /Do not repeat completed work/)
  assert.match(inputMessage({ id: 'i', kind: 'policy-changed', from: 'a', to: 'b', effect: { proactive: false }, at: '' })!, /no longer accepted/)
  assert.equal(inputMessage({ id: 'i', kind: 'reopen', decisionId: 'd', at: '' }), undefined)
})
it('distinguishes passing provider failures from permanent ones', () => {
  for (const error of [Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { status: 503 }), Object.assign(new Error('connect'), { code: 'ECONNRESET' }), new TypeError('fetch failed')]) assert.equal(transient(error), true)
  for (const error of [Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('x'), { status: 401 }), new Error('context too long'), 'offline']) assert.equal(transient(error), false)
})
it('launches once, delivers and reads a follow-up, reports waiting and stops only its worker', async t => {
  const h = await fixture(); t.after(h.stop)
  const one = await h.accept('1'), other = await h.accept('2')
  assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.state, 'running')
  h.engine.receive(h.trigger('follow', '1')); await h.effects.idle()
  const input = h.store.tickets.get(one.ticket.id)!.inputs.find(input => input.kind === 'trigger')
  assert.ok(input?.kind === 'trigger' && input.readAt)
  assert.equal(h.store.tickets.get(one.ticket.id)!.undelivered.length, 0)
  h.server.finish(one.threadId, 'completed', 'Verified result')
  await waitFor(() => assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.report?.state, 'waiting'))
  assert.ok(h.relays.some(text => text.includes('Verified result')))
  h.engine.stopTicket(one.ticket.id); await h.effects.idle(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.sessions.agents.get(other.sessionId)?.status, 'running')
})
it('does not cancel a worker when the ending transaction rolls back', async t => {
  const h = await fixture(); t.after(h.stop); const one = await h.accept('1')
  assert.throws(() => h.store.atomic(() => { h.engine.stopTicket(one.ticket.id); throw new Error('rollback') }))
  await h.effects.idle()
  assert.equal(h.store.tickets.get(one.ticket.id)!.ended, undefined)
  assert.equal(h.server.calls.filter(call => call.method === 'turn/interrupt').length, 0)
  h.engine.stopTicket(one.ticket.id); await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.server.calls.filter(call => call.method === 'turn/interrupt').length, 1)
})
it('keeps a paused launch queued and completes it after processing resumes', async t => {
  const h = await fixture(); t.after(h.stop); h.pause(true)
  const one = await h.accept('1')
  assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.state, 'pending')
  assert.equal(h.server.calls.filter(call => call.method === 'turn/start').length, 0)
  h.pause(false); await h.effects.idle()
  assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.state, 'running')
})
it('holds automatic inputs at capacity and wakes for a person in the reserved slot', async t => {
  const h = await fixture(); t.after(h.stop); h.configure({ maxWorkers: 1 })
  const one = await h.accept('1'); h.server.finish(one.threadId); await new Promise(resolve => setImmediate(resolve))
  const two = await h.accept('2')
  h.engine.receive(h.trigger('bot', '1', false)); await h.effects.idle()
  assert.equal(h.store.tickets.get(one.ticket.id)!.undelivered.length, 1)
  h.engine.receive(h.trigger('human', '1')); await h.effects.idle()
  assert.equal(h.sessions.agents.get(one.sessionId)?.status, 'running')
  assert.equal(h.sessions.agents.get(two.sessionId)?.status, 'running')
  assert.equal(h.store.tickets.get(one.ticket.id)!.undelivered.length, 0)
})
it('rechecks authorization after a slow source link and sends nothing to a stopped ticket', async t => {
  const h = await fixture(); t.after(h.stop); const one = await h.accept('1'), gate = deferred()
  let looked = false
  h.host.sourceLink = async () => { looked = true; await gate.promise; return {} }
  h.engine.receive(h.trigger('follow', '1'))
  await waitFor(() => assert.ok(looked))
  const sent = h.server.calls.filter(call => call.method === 'turn/steer').length
  h.engine.stopTicket(one.ticket.id); gate.resolve(); await h.effects.idle()
  assert.equal(h.server.calls.filter(call => call.method === 'turn/steer').length, sent)
  assert.equal(h.store.tickets.get(one.ticket.id)!.delivery, undefined)
})
it('records delivery failures and retains the intended input for one successful retry', async t => {
  const h = await fixture(); t.after(h.stop); const one = await h.accept('1')
  h.server.failure = method => method === 'turn/steer' ? Object.assign(new Error('Temporarily busy'), { code: -32600 }) : undefined
  h.engine.receive(h.trigger('follow', '1')); await h.effects.idle()
  assert.match(h.store.tickets.get(one.ticket.id)!.delivery?.error ?? '', /Temporarily busy/)
  assert.equal(h.store.tickets.get(one.ticket.id)!.undelivered.length, 1)
  h.server.failure = undefined; h.advance(); await h.effects.idle()
  assert.equal(h.store.tickets.get(one.ticket.id)!.delivery, undefined)
  assert.equal(h.store.tickets.get(one.ticket.id)!.undelivered.length, 0)
  const history = h.server.threads.get(one.threadId)!.turns.flatMap(turn => turn.items)
  assert.equal(history.length, 2)
})
it('does not replay a rejected input after its ready worker is stopped', async t => {
  const h = await fixture(); t.after(h.stop); const one = await h.accept('1')
  h.engine.bindThread(one.ticket.id, { source: 'github', id: 'pr' }, true)
  h.engine.report(one.ticket.id, { state: 'ready', summary: 'Awaiting review' })
  h.server.failure = method => method === 'turn/steer' ? Object.assign(new Error('busy'), { code: -32600 }) : undefined
  h.engine.receive(h.trigger('follow', '1')); await h.effects.idle()
  assert.ok(h.store.tickets.get(one.ticket.id)!.delivery)
  h.server.failure = undefined
  h.engine.stopTicket(one.ticket.id)
  h.server.finish(one.threadId)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.server.threads.get(one.threadId)!.turns.length, 1)
})
it('retries a passing launch failure three times and then records failure instead of silently dropping it', async t => {
  const h = await fixture(); t.after(h.stop)
  let tries = 0
  h.host.sourceLink = () => { tries++; return Promise.reject(Object.assign(new Error('Service Unavailable'), { status: 503 })) }
  const one = await h.accept('1')
  for (let retry = 0; retry < 3; retry++) { h.advance(300_000); await h.effects.idle() }
  assert.equal(tries, 4)
  assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.report?.state, 'failed')
  assert.equal(h.effects.pending('launch'), false)
  assert.equal(h.server.calls.filter(call => call.method === 'turn/start').length, 0)
})
it('keeps a rejected first turn pending so its transient launch retry actually starts the worker', async t => {
  const h = await fixture(); t.after(h.stop)
  h.server.failure = method => method === 'turn/start' ? Object.assign(new Error('503 Service Unavailable'), { code: -32603 }) : undefined
  const one = await h.accept('1')
  assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.state, 'pending')
  h.server.failure = undefined; h.advance(300_000); await h.effects.idle()
  assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.state, 'running')
  assert.equal(h.server.threads.get(one.threadId)!.turns.length, 1)
})
it('fails preparation without an automatic retry and lets a new human input try preparation again', async t => {
  const h = await fixture(); t.after(h.stop); h.configure({ prepare: 'prepare workspace' })
  let prepares = 0, fail = true
  h.host.context.subprocess.spawn = spec => {
    if (spec.argv[0] === 'sh') prepares++
    return { done: Promise.resolve({ exitCode: spec.argv[0] === 'sh' && fail ? 2 : 0 }), collected: {} }
  }
  const one = await h.accept('1')
  assert.match(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.report?.summary ?? '', /prepare command failed/)
  h.advance(300_000); await h.effects.idle(); assert.equal(prepares, 1)
  fail = false; h.engine.receive(h.trigger('try-again', '1')); await h.effects.idle()
  assert.equal(prepares, 2); assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.state, 'running')
})
it('resumes a worker after a passing turn failure, before failing it after its fourth consecutive failure', async t => {
  const h = await fixture(); t.after(h.stop); const one = await h.accept('1')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fail = () => { h.server.emit(one.threadId, 'error', { error: { message: 'Service Unavailable', status: 503 } }); h.server.finish(one.threadId, 'interrupted') }
  fail(); t.mock.timers.tick(15_000)
  await waitFor(() => assert.equal(h.server.calls.filter(call => call.method === 'turn/start').length, 2))
  assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.report, undefined)
  fail(); fail(); fail()
  await waitFor(() => assert.equal(latestAssignment(h.store.tickets.get(one.ticket.id)!)?.report?.state, 'failed'))
  t.mock.timers.reset()
})
it('prepares independent workers concurrently without blocking trigger intake', async t => {
  const h = await fixture(); t.after(h.stop); h.configure({ prepare: 'prepare workspace', maxWorkers: 2 })
  const gate = deferred(); let prepares = 0
  h.host.context.subprocess.spawn = spec => {
    if (spec.argv[0] === 'sh') prepares++
    return { done: spec.argv[0] === 'sh' ? gate.promise.then(() => ({ exitCode: 0 })) : Promise.resolve({ exitCode: 0 }), collected: {} }
  }
  try {
    for (const id of ['1', '2']) { h.engine.receive(h.trigger(id)); h.engine.decide(id, { kind: 'accept', name: 'fix-work', title: 'Fix', scope: 'small', reason: 'asked' }) }
    await waitFor(() => assert.equal(prepares, 2))
    assert.equal(h.engine.receive(h.trigger('3')), 'stored')
    assert.equal(h.store.tickets.open().every(ticket => latestAssignment(ticket)?.state === 'pending'), true)
  } finally { gate.resolve() }
  await h.effects.idle()
  assert.ok(h.store.tickets.open().every(ticket => latestAssignment(ticket)?.state === 'running'))
})
