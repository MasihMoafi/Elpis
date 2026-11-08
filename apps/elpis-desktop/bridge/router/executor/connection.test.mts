import { it } from 'node:test';
import assert from 'node:assert/strict'
import { once, type EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { runtimeAdapters, object } from './adapters.mts';
import { FakeServer } from './fixtures.mts';
import { tool } from '../app/tools/tool.mts';
import { z } from 'zod';

type Socket = EventEmitter & { send(data: string): void }
type Server = EventEmitter & { address(): AddressInfo | string | null; close(done: (error?: Error) => void): void }
const { WebSocketServer } = createRequire(import.meta.url)('ws') as { WebSocketServer: new (options: { host: string; port: number }) => Server }

it('uses the packaged connection helper for runtime lifecycle and bidirectional Elpis tools without calling a model', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }), fixture = new FakeServer()
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const closed: Promise<void>[] = []
  server.on('connection', (socket: Socket) => {
    const connection = fixture.connect()
    connection.requests?.add(message => { socket.send(JSON.stringify(message)); return true })
    connection.listeners.add(message => socket.send(JSON.stringify(message)))
    closed.push(new Promise<void>(resolve => socket.on('close', () => { connection.close(); resolve() })))
    socket.on('message', (data: Buffer) => {
      const message = object(JSON.parse(String(data)))
      if (message.id === undefined) return
      if (!message.method && (typeof message.id === 'string' || typeof message.id === 'number')) { connection.respond?.(message.id, object(message.result)); return }
      const result = message.method === 'initialize' ? Promise.resolve({}) : connection.call(String(message.method), object(message.params))
      void result.then(value => socket.send(JSON.stringify({ id: message.id, result: value })), error => socket.send(JSON.stringify({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : 'fixture error' } })))
    })
  })
  const adapters = await runtimeAdapters({ url: `ws://127.0.0.1:${address.port}` }), adapter = adapters.find(adapter => adapter.runtime === 'elpis')!
  try {
    const session = await adapter.open({ cwd: '/project', name: 'Protocol check', model: { provider: 'openai', model: 'fake-model' } })
    adapter.bind?.(session.threadId, { tools: () => [tool({ name: 'orchestrator_probe', description: 'Read evidence', schema: z.object({ value: z.string() }), execute: ({ value }) => ({ evidence: value }) })],
      instructions: () => 'Read scoped evidence.', authorize() {}, signal: new AbortController().signal })
    assert.deepEqual(await fixture.tool(session.threadId, 'orchestrator_probe', { value: 'received' }), { success: true, value: { evidence: 'received' } })
    assert.equal((await fixture.tool(session.threadId, 'orchestrator_probe', { value: 3 })).success, false)
    const received: unknown[] = [], unsubscribe = adapter.subscribe(session.threadId, message => received.push(message))
    const turn = await adapter.send(session.threadId, 'once', 'Offline fixture request', null)
    assert.equal((await adapter.read(session.threadId)).messages[0]?.id, 'once')
    await adapter.stop(session.threadId, turn)
    assert.ok(received.some(message => object(message).method === 'turn/completed'))
    assert.equal((await adapter.read(session.threadId)).activeTurn, null)
    unsubscribe()
  } finally {
    for (const adapter of adapters) adapter.close()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(new Error('The fixture server did not close', { cause: error })) : resolve()))
    await Promise.all(closed)
  }
  assert.equal(fixture.connections.size, 0)
})
