import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopClient } from '../client.mts'
import { dispatchModel } from './model.mts'
import { waitFor } from './executor/fixtures.test.mts'
import type { Candidate } from './core/index.mts'

const CHAT = '00000000-0000-0000-0000-000000000001'
const SIDE = '00000000-0000-0000-0000-000000000002'
const candidate: Candidate = { evalId: 'eval', policyVersion: 'v1', strength: 'explicit', tickets: [],
  thread: { key: 'elpis-chat:mother', ref: { source: 'elpis-chat', id: CHAT }, createdAt: '', subscriptions: [], correlated: [], pending: [], meta: {} },
  triggers: [{ id: 'request', source: 'elpis-chat', threads: [{ source: 'elpis-chat', id: 'mother' }], at: '', text: 'Hello Mother', human: true, actor: { source: 'elpis-chat', id: 'me' }, meta: {} }] }

for (const abort of [false, true]) test(`dispatch uses the existing provider side-turn and ${abort ? 'cancels it on shutdown' : 'returns its answer without a visible chat'}`, async () => {
  const home = mkdtempSync(join(tmpdir(), 'mother-model-')), calls: { method: string; params: Record<string, unknown> }[] = []
  const socket = Object.assign(new EventEmitter(), { close() {}, send(raw: string) {
    const request = JSON.parse(raw) as { id?: string; method: string; params: Record<string, unknown> }
    if (!request.id) return
    calls.push(request)
    let result: object
    if (request.method === 'initialize') result = {}
    else if (request.method === 'config/read') result = { config: { mcp_servers: { personal: {}, company: {} } } }
    else if (request.method === 'thread/read') result = { thread: { id: CHAT, status: { type: 'idle' } } }
    else if (request.method === 'thread/items/list') result = { data: [{ turnId: 'old', item: { id: 'old-reply', type: 'agentMessage', text: 'The earlier agreed constraint' } }], nextCursor: null }
    else if (request.method === 'thread/start') result = { thread: { id: SIDE, ephemeral: true } }
    else if (request.method === 'turn/start') {
      result = { turn: { id: 'routing' } }
      if (!abort) queueMicrotask(() => {
        socket.emit('message', JSON.stringify({ method: 'item/completed', params: { threadId: SIDE, item: { type: 'agentMessage', text: '{"action":"reply","text":"Hello"}' } } }))
        socket.emit('message', JSON.stringify({ method: 'turn/completed', params: { threadId: SIDE, turn: { id: 'routing', status: 'completed' } } }))
      })
    } else if (['turn/interrupt', 'thread/unsubscribe'].includes(request.method)) result = {}
    else throw new Error(`Unexpected model RPC: ${request.method}`)
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })))
  } })
  const client = new DesktopClient(socket, { home, appHome: home }), visible: unknown[] = []
  client.on('event', value => visible.push(value))
  try {
    await client.initialize()
    const controller = new AbortController()
    const answer = dispatchModel(client, () => ({ provider: 'my-provider', model: 'my-model', reasoningEffort: 'high' }))(candidate, controller.signal)
    await waitFor(() => assert.ok(calls.some(call => call.method === 'turn/start')))
    if (abort) { controller.abort(); await assert.rejects(answer, /stopped/); assert.ok(calls.some(call => call.method === 'turn/interrupt')) }
    else assert.deepEqual(await answer, { action: 'reply', text: 'Hello' })
    const start = calls.find(call => call.method === 'thread/start')!
    assert.equal(start.params.model, 'my-model'); assert.equal(start.params.modelProvider, 'my-provider'); assert.equal(start.params.ephemeral, true)
    assert.equal(start.params.permissions, ':read-only')
    assert.deepEqual(start.params.config, { 'mcp_servers.personal.enabled': false, 'mcp_servers.company.enabled': false })
    assert.equal(calls.find(call => call.method === 'turn/start')?.params.effort, 'high')
    assert.match(JSON.stringify(calls.find(call => call.method === 'turn/start')?.params.input), /The earlier agreed constraint/)
    assert.ok(calls.some(call => call.method === 'thread/unsubscribe'))
    assert.equal(client.listenerCount('side'), 0)
    assert.equal(visible.some(value => typeof value === 'object' && value !== null && 'type' in value && value.type === 'message'), false)
  } finally { client.close(); rmSync(home, { recursive: true, force: true }) }
})
