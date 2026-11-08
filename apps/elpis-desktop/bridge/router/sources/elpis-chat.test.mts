// Ported from dsh-superagent (MIT), tests/sources.spec.ts (shape)
import { test } from 'node:test';
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RouterStore } from '../infra/store.mts';
import { Commands } from '../infra/commands.mts';
import { testDeployment } from '../infra/fixtures.mts';
import { Engine, type Trigger } from '../core/index.mts';
import { SourceRegistry } from './registry.mts';
import type { SourceContext } from './host.mts';
import { createElpisChatKind, pollElpisChat, elpisChatTriggerId, startElpisChat, type ElpisChatMessage, type ElpisChatTransport } from './elpis-chat.mts';

const CHAT = '00000000-0000-0000-0000-000000000001'
const message = (id: string, role: ElpisChatMessage['role'] = 'user'): ElpisChatMessage =>
  ({ id, threadId: CHAT, role, actorId: 'alice', at: '2026-11-07T00:00:00Z', text: `message ${id}` })

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'router-chat-'))
  let store = new RouterStore(home)
  let config: { threadId: string; pollSeconds: number } | undefined = { threadId: CHAT, pollSeconds: 1 }
  const received: Trigger[] = [], reads: (string | undefined)[] = []
  const messages: ElpisChatMessage[] = []
  const replies = new Map<string, string>()
  const transport: ElpisChatTransport = {
    async read(_thread, after) { reads.push(after); return messages.slice(Math.max(0, messages.findIndex(item => item.id === after) + 1)) },
    async appendAssistant(thread, reply) { replies.set(`${thread}:${reply.id}`, replies.get(`${thread}:${reply.id}`) ?? reply.text); return 'sent' },
  }
  const sources = new SourceRegistry(() => ({ sources: { 'elpis-chat': { enabled: !!config, config: config ?? {} } }, policy: { sources: {} } }))
  const health: Record<string, { state: string; detail: string }> = {}
  const ctx: SourceContext = {
    deployment: testDeployment(), commands: new Commands(testDeployment, {}, new AbortController().signal), ready: Promise.resolve(),
    configured: () => true,
    config: <C extends Record<string, unknown>,>() => config ? sources.instance<C>('elpis-chat')?.config : undefined,
    receive(trigger) { received.push(trigger); store.triggers.save(trigger); return 'stored' },
    atomic: work => store.atomic(work),
    state: { get: key => store.state.get(key), set: (key, value) => store.state.set(key, value), keys: family => store.state.keys(family) },
    triggers: { get: id => store.triggers.get(id), latest: () => undefined },
    threads: { get: id => store.threads.get(id), subscribed: () => [], describe() {}, patch() {} },
    tickets: { get: id => store.tickets.get(id), open: () => store.tickets.open(), bindThread() {}, threadClosed() {} },
    notify() {}, report: (entry, value) => { health[entry] = value },
  }
  const release = sources.register(createElpisChatKind(transport))
  return { ctx, transport, sources, messages, received, replies, reads, health, release,
    disable: () => { config = undefined }, select: (threadId: string) => { config = { threadId, pollSeconds: 1 } },
    store: () => store, restart: () => { store.close(); store = new RouterStore(home) },
    close: () => { store.close(); rmSync(home, { recursive: true, force: true }) } }
}

test('chat intake keeps order and identity, ignores assistant/other chats, and preserves its first immutable event', async () => {
  const f = fixture()
  try {
    f.messages.push(message('1'), message('bot', 'assistant'), { ...message('other'), threadId: 'other' }, message('2'), message('1'))
    await pollElpisChat(f.ctx, f.transport)
    assert.deepEqual(f.received.map(item => item.meta.messageId), ['1', '2'])
    assert.deepEqual(f.received[0]?.actor, { source: 'elpis-chat', id: 'alice' })
    assert.equal(f.received[0]?.addressed, 'direct')
    assert.deepEqual(f.received[0]?.threads, [{ source: 'elpis-chat', id: CHAT }])
    f.messages.push({ ...message('1'), text: 'edited' })
    await pollElpisChat(f.ctx, f.transport)
    assert.equal(f.store().triggers.get(elpisChatTriggerId(CHAT, '1'))?.text, 'message 1')
    assert.equal(f.received.length, 2)
  } finally { f.close() }
})

test('failed intake retries the uncommitted message after reopening the durable store', async () => {
  const f = fixture()
  try {
    f.messages.push(message('1'), message('2'), message('3'))
    const receive = f.ctx.receive
    f.ctx.receive = trigger => { if (trigger.meta.messageId === '2') throw new Error('disk unavailable'); return receive(trigger) }
    await assert.rejects(pollElpisChat(f.ctx, f.transport), /disk unavailable/)
    f.restart(); f.ctx.receive = receive
    await pollElpisChat(f.ctx, f.transport)
    assert.deepEqual(f.reads, [undefined, '1'])
    assert.deepEqual(f.received.map(item => item.meta.messageId), ['1', '2', '3'])
    f.restart(); await pollElpisChat(f.ctx, f.transport)
    assert.equal(f.reads.at(-1), '3')
    assert.equal(f.received.length, 3)
  } finally { f.close() }
})

test('replays a message stored before its cursor committed without receiving it twice', async () => {
  const f = fixture()
  try {
    f.messages.push(message('1'), message('2'))
    const receive = f.ctx.receive
    f.ctx.receive = async trigger => { await receive(trigger); throw new Error('lost acknowledgement') }
    await assert.rejects(pollElpisChat(f.ctx, f.transport), /lost acknowledgement/)
    f.restart(); f.ctx.receive = receive
    await pollElpisChat(f.ctx, f.transport)
    assert.deepEqual(f.received.map(item => item.meta.messageId), ['1', '2'])
  } finally { f.close() }
})

test('overlapping polls serialize; disabling or selecting another chat during a read admits nothing stale', async () => {
  const f = fixture()
  try {
    let unblock: () => void = () => {}
    const pending = new Promise<void>(resolve => { unblock = resolve })
    const read = f.transport.read
    f.transport.read = async (...args) => { await pending; return read(...args) }
    f.messages.push(message('1'))
    const first = pollElpisChat(f.ctx, f.transport), second = pollElpisChat(f.ctx, f.transport)
    unblock(); await Promise.all([first, second])
    assert.deepEqual(f.reads, [undefined, '1'])
    f.transport.read = async () => { f.disable(); return [message('2')] }
    await pollElpisChat(f.ctx, f.transport)
    assert.equal(f.received.length, 1)
    f.select(CHAT)
    f.transport.read = async () => { f.select('other'); return [message('3')] }
    await pollElpisChat(f.ctx, f.transport)
    assert.equal(f.received.length, 1)
  } finally { f.close() }
})

test('registered channel retries the same reply ID and keeps delivery in the selected conversation', async () => {
  const f = fixture()
  try {
    const channel = { source: 'elpis-chat', thread: `elpis-chat:${CHAT}`, address: { threadId: CHAT } }
    const reply = { id: 'reply-1', channel, text: 'May I run the helper?', kind: 'reply' as const }
    const append = f.transport.appendAssistant
    f.transport.appendAssistant = async (...args) => { await append(...args); throw new Error('lost acknowledgement') }
    await assert.rejects(f.sources.send(reply, f.ctx.commands), /lost acknowledgement/)
    f.transport.appendAssistant = append
    assert.equal(await f.sources.send(reply, f.ctx.commands), 'sent')
    assert.equal(f.replies.size, 1)
    assert.equal(f.replies.get(`${CHAT}:reply-1`), reply.text)
    assert.equal(f.sources.channelAllowed(channel), true)
    f.disable(); assert.equal(f.sources.channelAllowed(channel), false)
    await assert.rejects(f.sources.send({ ...reply, channel: { ...channel, address: {} } }, f.ctx.commands), /target/)
  } finally { f.close() }
})

test('chat follow-ups reach executor-ended tickets but do not resume human-stopped tickets or echo assistant messages', async () => {
  for (const stopped of [false, true]) {
    const f = fixture()
    try {
      const engine = new Engine({ repo: f.store(), scope: f.sources,
        policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => false }),
        assessor: { request() {} }, executor: { start() {}, deliver() {}, stop() {} },
        outbox: { send() {}, status: () => undefined, withdraw() {} } })
      f.ctx.receive = trigger => engine.receive(trigger)
      f.messages.push(message('1')); await pollElpisChat(f.ctx, f.transport)
      const decision = engine.decide(elpisChatTriggerId(CHAT, '1'), { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' })
      assert.ok(decision.ticketId)
      if (stopped) engine.stopTicket(decision.ticketId)
      else engine.report(decision.ticketId, { state: 'ready', summary: 'done' })
      f.messages.push(message('bot', 'assistant')); await pollElpisChat(f.ctx, f.transport)
      assert.ok(f.store().tickets.get(decision.ticketId)?.ended)
      f.messages.push({ ...message('2'), actorId: 'guest' }); await pollElpisChat(f.ctx, f.transport)
      assert.equal(!!f.store().tickets.get(decision.ticketId)?.ended, stopped)
    } finally { f.close() }
  }
})

test('source start registers the kind and stop aborts its in-flight read and unregisters it', { timeout: 5000 }, async () => {
  const f = fixture()
  try {
    f.release()
    let began: () => void = () => {}
    const started = new Promise<void>(resolve => { began = resolve })
    f.transport.read = async (_thread, _after, signal) => {
      began()
      return new Promise(resolve => { signal?.addEventListener('abort', () => resolve([]), { once: true }) })
    }
    const stop = startElpisChat({ sources: f.sources, context: () => f.ctx }, f.transport)
    await started; await stop()
    assert.equal(f.sources.kind('elpis-chat'), undefined)
    assert.equal(f.received.length, 0)
  } finally { f.close() }
})

test('source reports a failed read, recovers on retry, and disposes while setup is still pending', { timeout: 5000 }, async () => {
  const f = fixture()
  let stop: (() => Promise<void>) | undefined
  try {
    f.release()
    let attempts = 0, recovered: () => void = () => {}
    const states: string[] = []
    const ready = new Promise<void>(resolve => { recovered = resolve })
    const report = f.ctx.report
    f.ctx.report = (entry, health) => { states.push(health.state); report(entry, health); if (health.state === 'ready') recovered() }
    f.transport.read = async () => { if (++attempts === 1) throw new Error('read failed'); return [] }
    stop = startElpisChat({ sources: f.sources, context: () => f.ctx }, f.transport)
    await ready
    assert.equal(attempts, 2)
    assert.deepEqual(states, ['error', 'ready'])
    assert.equal(f.health['elpis-chat']?.state, 'ready')
    await stop(); stop = undefined
    const pending: SourceContext = { ...f.ctx, ready: new Promise<void>(() => {}) }
    stop = startElpisChat({ sources: f.sources, context: () => pending }, f.transport)
    await stop(); stop = undefined
    assert.equal(f.sources.kind('elpis-chat'), undefined)
  } finally { await stop?.(); f.close() }
})
