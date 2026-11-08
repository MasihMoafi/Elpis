import { test } from 'node:test';
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopClient } from '../client.mts';
import { MotherAgent } from './mother-agent.mts';
import { ElpisAdapter } from './executor/adapters.mts';
import { FakeServer, waitFor } from './executor/fixtures.mts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { StateView } from './app/http.mts';
import { WebSocketServer } from 'ws';

const CHAT = '00000000-0000-0000-0000-000000000001'

async function panel<T>(mother: MotherAgent, path: string, value?: unknown, method = value === undefined ? 'GET' : 'PUT'): Promise<T> {
  const server = createServer((req, res) => { void mother.handle(req, res, String((server.address() as { port: number }).port)) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/mother/${path}`, {
      method, headers: { 'x-orchestrator-request': '1', 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }),
    })
    const body = await response.json() as T
    assert.equal(response.status, 200, JSON.stringify(body)); return body
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}

test('an offline executor remains paused until Elpis is enabled, independently of the saved processing pause', async () => {
  const h = fixture(), mother = h.create()
  try {
    await h.client.initialize()
    assert.equal((await panel<StateView>(mother, 'state')).paused, true)
    await panel(mother, 'executor/pause', { paused: false }, 'POST')
    assert.equal((await panel<StateView>(mother, 'state')).paused, true)
    assert.equal(h.adapterStarts, 0)
    await mother.save({ version: mother.snapshot().version, enabled: true })
    assert.equal((await panel<StateView>(mother, 'state')).paused, false)
    await panel(mother, 'executor/pause', { paused: true }, 'POST')
    assert.equal((await panel<StateView>(mother, 'state')).paused, true)
    assert.ok(h.adapterStarts > 0)
  } finally { await mother.close(); h.client.close(); rmSync(h.home, { recursive: true, force: true }) }
})

test('the panel reports off, missing model, running and disconnected states without inventing startup', async () => {
  const h = fixture(), mother = h.create()
  try {
    await h.client.initialize(); await mother.start()
    const off = await panel<StateView>(mother, 'state')
    assert.equal(off.health.runtime?.state, 'paused'); assert.match(off.health.runtime?.detail ?? '', /off/i)
    assert.equal(off.setup.accounts, null); assert.equal(h.adapterStarts, 0)
    h.unsetDefaults()
    await mother.save({ version: mother.snapshot().version, enabled: true })
    const missing = await panel<StateView>(mother, 'state')
    assert.equal(missing.health.runtime?.state, 'error'); assert.match(missing.health.runtime?.detail ?? '', /model/i)
    await mother.save({ version: mother.snapshot().version, roles: roles('saved') })
    const running = await panel<StateView>(mother, 'state')
    assert.equal(running.health.runtime?.state, 'ready')
    h.client.close()
    const disconnected = await panel<StateView>(mother, 'state')
    assert.equal(disconnected.health.runtime?.state, 'error'); assert.match(disconnected.health.runtime?.detail ?? '', /connect/i)
  } finally { await mother.close(); h.client.close(); rmSync(h.home, { recursive: true, force: true }) }
})

test('a router model saved in the agent panel replaces the running router session', async () => {
  const h = fixture({ fresh: true }), mother = h.create()
  try {
    await h.client.initialize(); await mother.start()
    await mother.send(CHAT, { text: 'Keep this goal through a router model change.' })
    await waitFor(() => assert.ok([...h.workers.threads.values()][0]?.turns.length))
    const settings = await panel<{ blocks: { eval: { revision: number; value: object } } }>(mother, 'settings')
    await panel(mother, 'settings/eval', { revision: settings.blocks.eval.revision,
      value: { ...settings.blocks.eval.value, model: { provider: 'openai', model: 'router-saved' } } })
    await waitFor(() => assert.equal(h.workers.calls.filter(call => call.method === 'thread/start').length, 2))
    assert.equal(h.workers.calls.findLast(call => call.method === 'thread/start')?.params.model, 'router-saved')
    assert.ok(h.workers.calls.some(call => call.method === 'thread/archive'))
    await waitFor(() => assert.match(JSON.stringify([...h.workers.threads.values()][1]?.turns), /Keep this goal through a router model change/))
    await mother.start()
    assert.equal(h.workers.calls.filter(call => call.method === 'turn/start').length, 2, 'A reconnect must not replay an already delivered candidate')
  } finally { await mother.close(); h.client.close(); rmSync(h.home, { recursive: true, force: true }) }
})

function fixture({ fresh = false, native = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'mother-bridge-')), workers = new FakeServer()
  if (!fresh) { mkdirSync(join(home, 'router'), { recursive: true }); writeFileSync(join(home, 'router', 'mother.json'), JSON.stringify({ enabled: false })) }
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let adapterStarts = 0, created = false, name = '', configured = true, archived = false
  const socket = Object.assign(new EventEmitter(), { close() {}, send(raw: string) {
    const request = JSON.parse(raw) as { id?: string; method: string; params: Record<string, unknown> }
    if (!request.id) return
    calls.push(request)
    let result: object
    switch (request.method) {
      case 'initialize': result = {}; break
      case 'config/read': result = { config: { model: configured ? 'chosen-main' : null, model_provider: 'openai', background_model: configured ? 'chosen-background' : null, background_provider: 'openai' }, layers: [{ name: { type: 'user', file: join(home, 'config.toml') }, version: 'v1' }] }; break
      case 'configRequirements/read': result = { requirements: null }; break
      case 'pruner/read': result = {}; break
      case 'experimentalFeature/list': result = { data: [] }; break
      case 'model/list': result = { data: ['chosen-main', 'chosen-background', 'router-saved', 'worker-saved'].map(model => ({ id: model, model, displayName: model, supportedReasoningEfforts: [] })) }; break
      case 'thread/start': created = true; result = { thread: { id: CHAT, name, status: { type: 'idle' } }, model: request.params.model, modelProvider: 'openai' }; break
      case 'thread/name/set': name = String(request.params.name); result = {}; break
      case 'thread/list': result = { data: [] }; break
      case 'thread/archive': archived = true; result = {}; break
      case 'thread/unarchive': archived = false; result = { thread: { id: CHAT } }; break
      case 'thread/resume': result = { thread: { id: CHAT, name, path: join(home, archived ? 'archived_sessions' : 'sessions', `${CHAT}.jsonl`), status: { type: 'idle' } } }; break
      case 'thread/delete': created = false; result = {}; break
      case 'thread/read': if (!created) { queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: 'thread not found' } }))); return } result = { thread: { id: CHAT, name, path: join(home, archived ? 'archived_sessions' : 'sessions', `${CHAT}.jsonl`), status: { type: 'idle' } } }; break
      case 'thread/items/list': result = { data: [], nextCursor: null }; break
      case 'thread/unsubscribe': result = {}; break
      default: throw new Error(`Unexpected RPC ${request.method}`)
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })))
  } })
  const client = new DesktopClient(socket, { home, appHome: home, githubConnector: { instructions: async () => '' } })
  const create = () => new MotherAgent({ client, home, ...(native ? {} : { adapters: async () => { adapterStarts++; return [new ElpisAdapter(workers.connect)] } }) })
  return { home, workers, calls, socket, client, create, get name() { return name }, get adapterStarts() { return adapterStarts }, unsetDefaults() { configured = false }, archiveExternally() { archived = true } }
}

test('the router joins this profile’s explicit bridge socket and ignores another profile’s endpoint', async () => {
  const h = fixture({ fresh: true, native: true }), server = createServer(), sockets = new WebSocketServer({ server })
  const socketPath = join(h.home, 'bridge.sock')
  const previous = { ELPIS_HOME: process.env.ELPIS_HOME, ELPIS_APP_BRIDGE_SOCKET: process.env.ELPIS_APP_BRIDGE_SOCKET }
  sockets.on('connection', socket => {
    const connection = h.workers.connect()
    connection.listeners.add(value => socket.send(JSON.stringify(value)))
    socket.on('close', () => connection.close())
    socket.on('message', raw => {
      const bytes = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw)
      const message = JSON.parse(bytes.toString('utf8')) as { id?: string | number; method?: string; params?: object; result?: object }
      if (message.id === undefined) return
      if (!message.method) { connection.respond?.(message.id, message.result ?? {}); return }
      const result = message.method === 'initialize' ? Promise.resolve({}) : connection.call(message.method, message.params ?? {})
      void result.then(result => socket.send(JSON.stringify({ id: message.id, result })))
    })
  })
  server.listen(socketPath); await once(server, 'listening'); chmodSync(socketPath, 0o600)
  process.env.ELPIS_HOME = h.home; process.env.ELPIS_APP_BRIDGE_SOCKET = socketPath
  let mother = h.create()
  try {
    await h.client.initialize(); await mother.start()
    assert.equal(mother.snapshot().error, undefined)
    assert.equal(h.workers.calls.filter(call => call.method === 'thread/start').length, 1)
    await mother.close()
    process.env.ELPIS_HOME = join(h.home, 'other-profile')
    mother = h.create(); await mother.start()
    assert.match(mother.snapshot().error ?? '', /No running Elpis bridge/)
    await waitFor(() => assert.equal(h.workers.connections.size, 0))
  } finally {
    await mother.close(); h.client.close()
    for (const socket of sockets.clients) socket.terminate()
    await new Promise<void>(resolve => sockets.close(() => server.close(() => resolve())))
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    rmSync(h.home, { recursive: true, force: true })
  }
})

test('a fresh install starts Elpis and its pinned chat without any setting', async () => {
  const h = fixture({ fresh: true }), { client, create } = h
  const elpis = create()
  try {
    await client.initialize(); await elpis.start()
    const on = elpis.snapshot()
    assert.equal(on.enabled, true); assert.equal(on.error, undefined); assert.ok(on.threadId); assert.ok(h.adapterStarts > 0)
  } finally { await elpis.close(); client.close(); rmSync(h.home, { recursive: true, force: true }) }
})

test('changing the router model replaces its session and the sidebar never lists it', async () => {
  const h = fixture({ fresh: true }), { client, workers } = h, elpis = h.create()
  try {
    await client.initialize(); await elpis.start()
    const first = workers.calls.filter(call => call.method === 'thread/start').length
    await elpis.save({ version: elpis.snapshot().version, roles: roles('router-saved') })
    const starts = workers.calls.filter(call => call.method === 'thread/start')
    assert.equal(starts.length, first + 1)
    assert.ok(workers.calls.some(call => call.method === 'thread/archive'))
    const router = { id: 'replaced-router', cwd: join(h.home, 'router') } as never, worker = { id: 'worker', cwd: join(h.home, 'work') } as never
    assert.deepEqual((await elpis.list([router, worker], {})).map(thread => thread.id).filter(id => id !== CHAT), ['worker'])
  } finally { await elpis.close(); client.close(); rmSync(h.home, { recursive: true, force: true }) }
})

test('real bridge chat storage stays offline until enabled, then routes persisted input and reopens one Elpis chat', async () => {
  const h = fixture(), { home, workers, calls, client, create } = h
  let mother = create()
  try {
    await client.initialize(); await mother.start()
    const off = mother.snapshot()
    assert.equal(off.enabled, false); assert.equal(off.threadId, null); assert.equal(h.adapterStarts, 0)
    assert.equal(existsSync(join(home, 'router', 'orchestrator.sqlite')), false)
    const on = await mother.save({ version: off.version, enabled: true })
    assert.equal(on.error, undefined); assert.equal(on.threadId, CHAT); assert.equal(h.name, 'Elpis')
    assert.equal(mother.decorate({ id: CHAT }).motherAgent, true)
    assert.equal((await mother.list([], {}))[0]?.id, CHAT, 'A Elpis chat without native turns still appears in the sidebar')
    assert.deepEqual(await mother.list([], { archived: true }), [])
    assert.equal(calls.find(call => call.method === 'thread/start')?.params.model, 'chosen-main')
    await assert.rejects(mother.save({ version: off.version, enabled: false }), /changed elsewhere/)
    const sent = await mother.send(CHAT, { text: 'Inspect this project' })
    assert.equal(sent.routed, true)
    const main = [...workers.threads.keys()][0]!
    await waitFor(() => assert.ok(workers.threads.get(main)?.turns.length))
    const input = workers.threads.get(main)!.turns[0]!.items[0] as { content: { text: string }[] }
    const message = input.content[0]!.text
    const candidate = JSON.parse(message.slice(message.indexOf('\n') + 1)) as { trigger_id: string }
    const routed = await workers.tool(main, 'orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: candidate.trigger_id,
      title: 'Inspect files', worktree_name: 'inspect-files', acknowledgement: 'I will inspect the files.' }] })
    assert.equal(routed.success, true)
    const ticketId = (routed.value as { results: { ticket: { ticket_id: string } }[] }).results[0]!.ticket.ticket_id
    await waitFor(() => assert.equal(workers.calls.filter(call => call.method === 'thread/start').length, 2))
    assert.equal(workers.calls.find(call => call.method === 'thread/start')?.params.model, 'chosen-main')
    assert.equal(calls.some(call => call.method === 'turn/start'), false, 'Input must not run another native turn in the source chat')
    await mother.close(); mother = create(); await mother.start()
    const worker = [...workers.threads.keys()][1]!
    assert.equal((await workers.tool(worker, 'orchestrator_report', { state: 'ready', summary: 'Inspected the files; focused checks passed.' })).success, true)
    assert.equal((await workers.tool(main, 'orchestrator_reply', { ticket_id: ticketId,
      purpose: 'result', text: 'Inspected the files; focused checks passed.' })).success, true)
    let history = await client.readThread(CHAT)
    await waitFor(async () => { history = await client.readThread(CHAT); assert.equal(history.data.filter(entry => entry.item.type === 'agentMessage').length, 2) })
    assert.equal(history.data[0]?.item.text, 'Inspected the files; focused checks passed.')
    await mother.close(); mother = create(); await mother.start()
    history = await client.readThread(CHAT)
    assert.equal(history.data.filter(entry => entry.item.type === 'agentMessage').length, 2)
    assert.equal(calls.filter(call => call.method === 'thread/start').length, 1)
    assert.equal(workers.calls.filter(call => call.method === 'thread/start').length, 2)
    const disabled = await mother.save({ version: mother.snapshot().version, enabled: false })
    assert.equal(disabled.enabled, false)
    await assert.rejects(mother.send(CHAT, { text: 'Do more' }), /Turn Elpis on/)
  } finally { await mother.close(); client.close(); rmSync(home, { recursive: true, force: true }) }
  assert.equal(workers.connections.size, 0)
})

const roles = (suffix: string) => ({ dispatch: { provider: 'openai', model: `router-${suffix}` }, worker: { provider: 'openai', model: `worker-${suffix}` } })

test('persisted explicit role models start a fresh Elpis without global defaults', async () => {
  const h = fixture()
  let mother = h.create()
  try {
    await h.client.initialize()
    await mother.save({ version: mother.snapshot().version, roles: roles('saved') })
    await mother.close(); h.unsetDefaults(); mother = h.create()
    const on = await mother.save({ version: mother.snapshot().version, enabled: true })
    assert.equal(on.error, undefined)
    assert.equal(h.calls.find(call => call.method === 'thread/start')?.params.model, 'router-saved')
    assert.equal(h.workers.calls.find(call => call.method === 'thread/start')?.params.model, 'router-saved')
  } finally { await mother.close(); h.client.close(); rmSync(h.home, { recursive: true, force: true }) }
})

test('two Elpis settings windows cannot overwrite role models with a stale version', async () => {
  const h = fixture(), mother = h.create()
  try {
    const original = mother.snapshot()
    const saved = await mother.save({ version: original.version, roles: roles('first') })
    assert.notEqual(saved.version, original.version)
    await assert.rejects(mother.save({ version: original.version, roles: roles('stale'), enabled: true }), /changed elsewhere/)
    assert.deepEqual(mother.snapshot().roles, roles('first'))
    assert.equal(mother.snapshot().enabled, false)
    await mother.save({ version: saved.version, roles: roles('new') })
    assert.deepEqual(mother.snapshot().roles, roles('new'))
  } finally { await mother.close(); h.client.close(); rmSync(h.home, { recursive: true, force: true }) }
})

test('the bound Elpis chat respects archive, trash exclusions, undo and permanent deletion', async () => {
  const h = fixture()
  let mother = h.create()
  try {
    await h.client.initialize()
    await mother.save({ version: mother.snapshot().version, enabled: true })
    assert.ok(h.workers.connections.size > 0)
    h.archiveExternally()
    assert.deepEqual(await mother.list([], {}), [], 'Native archive paths exclude a chat archived by another client')
    await mother.close(); mother = h.create(); await mother.start()
    assert.equal(h.workers.connections.size, 0, 'An externally archived Elpis must stay stopped after restart')
    await mother.mutate(CHAT, 'unarchiveThread', () => h.client.unarchiveThread(CHAT, {}))
    assert.equal((await mother.list([], {}))[0]?.id, CHAT)
    await assert.rejects(mother.mutate(CHAT, 'archiveThread', async () => { throw new Error('Archive unavailable') }), /Archive unavailable/)
    assert.ok(h.workers.connections.size > 0, 'A failed archive must leave Elpis running')
    await mother.mutate(CHAT, 'archiveThread', () => h.client.archiveThread(CHAT, {}))
    assert.equal(h.workers.connections.size, 0)
    assert.deepEqual(await mother.list([], {}), [])
    await mother.mutate(CHAT, 'unarchiveThread', () => h.client.unarchiveThread(CHAT, {}))
    assert.ok(h.workers.connections.size > 0)
    assert.equal((await mother.list([], {}))[0]?.id, CHAT)
    assert.deepEqual(await mother.list([], {}, id => id === CHAT), [])
    await mother.mutate(CHAT, 'deleteThread', () => h.client.deleteThread(CHAT, {}))
    assert.equal(mother.snapshot().threadId, null)
    await mother.start()
    assert.equal(mother.snapshot().error, undefined)
    assert.equal(mother.snapshot().threadId, CHAT)
    assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 2)
  } finally { await mother.close(); h.client.close(); rmSync(h.home, { recursive: true, force: true }) }
})
