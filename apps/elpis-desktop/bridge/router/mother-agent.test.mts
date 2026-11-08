import { test } from 'node:test';
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopClient } from '../client.mts';
import { MotherAgent } from './mother-agent.mts';
import { ElpisAdapter } from './executor/adapters.mts';
import { FakeServer, waitFor } from './executor/fixtures.mts';

const CHAT = '00000000-0000-0000-0000-000000000001'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'mother-bridge-')), workers = new FakeServer()
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
      case 'model/list': result = { data: ['chosen-background', 'router-saved', 'worker-saved'].map(model => ({ id: model, model, displayName: model, supportedReasoningEfforts: [] })) }; break
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
  const create = () => new MotherAgent({ client, home, adapters: async () => { adapterStarts++; return [new ElpisAdapter(workers.connect)] } })
  return { home, workers, calls, socket, client, create, get name() { return name }, get adapterStarts() { return adapterStarts }, unsetDefaults() { configured = false }, archiveExternally() { archived = true } }
}

test('real bridge chat storage stays offline until enabled, then routes persisted input and reopens one Mother chat', async () => {
  const h = fixture(), { home, workers, calls, client, create } = h
  let mother = create()
  try {
    await client.initialize(); await mother.start()
    const off = mother.snapshot()
    assert.equal(off.enabled, false); assert.equal(off.threadId, null); assert.equal(h.adapterStarts, 0)
    assert.equal(existsSync(join(home, 'router', 'orchestrator.sqlite')), false)
    const on = await mother.save({ version: off.version, enabled: true })
    assert.equal(on.error, undefined); assert.equal(on.threadId, CHAT); assert.equal(h.name, 'Mother agent')
    assert.equal(mother.decorate({ id: CHAT }).motherAgent, true)
    assert.equal((await mother.list([], {}))[0]?.id, CHAT, 'A Mother chat without native turns still appears in the sidebar')
    assert.deepEqual(await mother.list([], { archived: true }), [])
    assert.equal(calls.find(call => call.method === 'thread/start')?.params.model, 'chosen-background')
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
    assert.equal(workers.calls.find(call => call.method === 'thread/start')?.params.model, 'chosen-background')
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
    await assert.rejects(mother.send(CHAT, { text: 'Do more' }), /Turn Mother agent on/)
  } finally { await mother.close(); client.close(); rmSync(home, { recursive: true, force: true }) }
  assert.equal(workers.connections.size, 0)
})

const roles = (suffix: string) => ({ dispatch: { provider: 'openai', model: `router-${suffix}` }, worker: { provider: 'openai', model: `worker-${suffix}` } })

test('persisted explicit role models start a fresh Mother without global defaults', async () => {
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

test('two Mother settings windows cannot overwrite role models with a stale version', async () => {
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

test('the bound Mother chat respects archive, trash exclusions, undo and permanent deletion', async () => {
  const h = fixture()
  let mother = h.create()
  try {
    await h.client.initialize()
    await mother.save({ version: mother.snapshot().version, enabled: true })
    assert.ok(h.workers.connections.size > 0)
    h.archiveExternally()
    assert.deepEqual(await mother.list([], {}), [], 'Native archive paths exclude a chat archived by another client')
    await mother.close(); mother = h.create(); await mother.start()
    assert.equal(h.workers.connections.size, 0, 'An externally archived Mother must stay stopped after restart')
    await mother.mutate(CHAT, 'unarchiveThread', () => h.client.unarchiveThread(CHAT, {}))
    assert.equal((await mother.list([], {}))[0]?.id, CHAT)
    await assert.rejects(mother.mutate(CHAT, 'archiveThread', async () => { throw new Error('Archive unavailable') }), /Archive unavailable/)
    assert.ok(h.workers.connections.size > 0, 'A failed archive must leave Mother running')
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
