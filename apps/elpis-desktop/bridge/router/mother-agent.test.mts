import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopClient } from '../client.mts'
import { MotherAgent } from './mother-agent.mts'
import { ElpisAdapter } from './executor/adapters.mts'
import { FakeServer, waitFor } from './executor/fixtures.test.mts'

const CHAT = '00000000-0000-0000-0000-000000000001'

test('real bridge chat storage stays offline until enabled, then routes persisted input and reopens one Mother chat', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mother-bridge-')), workers = new FakeServer()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let adapterStarts = 0, created = false, name = ''
  const socket = Object.assign(new EventEmitter(), { close() {}, send(raw: string) {
    const request = JSON.parse(raw) as { id?: string; method: string; params: Record<string, unknown> }
    if (!request.id) return
    calls.push(request)
    let result: object
    switch (request.method) {
      case 'initialize': result = {}; break
      case 'config/read': result = { config: { model: 'chosen-main', model_provider: 'openai', background_model: 'chosen-background', background_provider: 'openai' }, layers: [{ name: { type: 'user', file: join(home, 'config.toml') }, version: 'v1' }] }; break
      case 'configRequirements/read': result = { requirements: null }; break
      case 'pruner/read': result = {}; break
      case 'experimentalFeature/list': result = { data: [] }; break
      case 'model/list': result = { data: [{ id: 'chosen-background', model: 'chosen-background', displayName: 'Chosen', supportedReasoningEfforts: [] }] }; break
      case 'thread/start': created = true; result = { thread: { id: CHAT, name, status: { type: 'idle' } }, model: request.params.model, modelProvider: 'openai' }; break
      case 'thread/name/set': name = String(request.params.name); result = {}; break
      case 'thread/read': assert.ok(created); result = { thread: { id: CHAT, name, status: { type: 'idle' } } }; break
      case 'thread/items/list': result = { data: [], nextCursor: null }; break
      case 'thread/unsubscribe': result = {}; break
      default: throw new Error(`Unexpected RPC ${request.method}`)
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })))
  } })
  const client = new DesktopClient(socket, { home, appHome: home, githubConnector: { instructions: async () => '' } })
  const create = () => new MotherAgent({ client, home, adapters: async () => { adapterStarts++; return [new ElpisAdapter(workers.connect)] } })
  let mother = create()
  try {
    await client.initialize(); await mother.start()
    const off = mother.snapshot()
    assert.equal(off.enabled, false); assert.equal(off.threadId, null); assert.equal(adapterStarts, 0)
    assert.equal(existsSync(join(home, 'router', 'orchestrator.sqlite')), false)
    const on = await mother.save({ version: off.version, enabled: true })
    assert.equal(on.error, undefined); assert.equal(on.threadId, CHAT); assert.equal(name, 'Mother agent')
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
