import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MotherApp } from './app.mts'
import { ElpisAdapter } from './executor/adapters.mts'
import { FakeServer, waitFor } from './executor/fixtures.test.mts'
import { SettingsSchema } from './executor/settings.mts'
import type { ElpisChatMessage } from './sources/elpis-chat.mts'
import { elpisChatTriggerId } from './sources/elpis-chat.mts'

test('Mother chat routes a goal, recovers one worker and posts one durable reply even after a lost acknowledgement', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mother-app-')), server = new FakeServer()
  const messages: ElpisChatMessage[] = [{ id: 'goal', threadId: 'mother', role: 'user', actorId: 'me', at: new Date().toISOString(), text: `Check this project. ${'context '.repeat(700)}END_CONSTRAINT` }]
  const replies = new Map<string, string>()
  let loseReply = true, modelCalls = 0
  const create = () => new MotherApp({ home, threadId: 'mother', settings: () => SettingsSchema.parse({ executor: { model: { provider: 'openai', model: 'my-worker' } } }),
    adapters: [new ElpisAdapter(server.connect)], subprocess: { spawn: () => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: '' }) } } }) },
    dispatch: async () => { modelCalls++; return { action: 'accept', title: 'Check project', name: 'check-project', scope: 'Inspect and report', reason: 'Requested' } },
    transport: { read: async (_thread, after) => messages.slice(after ? messages.findIndex(message => message.id === after) + 1 : 0), appendAssistant: async (_thread, reply) => {
      if (!replies.has(reply.id)) replies.set(reply.id, reply.text)
      if (loseReply) { loseReply = false; throw new Error('Acknowledgement lost') }
      return 'sent'
    } } })
  let app: MotherApp | undefined
  try {
    app = create(); await app.start(); await app.pump()
    assert.equal(app.store.tickets.list().length, 1)
    assert.equal(modelCalls, 1)
    const worker = [...server.threads.keys()][0]!
    assert.match(JSON.stringify(server.threads.get(worker)?.turns), /END_CONSTRAINT/, 'Workers receive the complete request, including text past the source preview limit')
    assert.equal(server.calls.filter(call => call.method === 'thread/start').length, 1)
    await app.close(); app = create(); await app.start(); await app.pump()
    assert.equal(server.calls.filter(call => call.method === 'thread/start').length, 1)
    server.finish(worker, 'completed', JSON.stringify({ state: 'ready', summary: 'Checked the project; focused checks passed.' }))
    await waitFor(() => assert.equal(app!.store.tickets.list()[0]?.ended?.outcome, 'completed'))
    await app.pump()
    assert.deepEqual([...replies.values()], ['Checked the project; focused checks passed.'])
    await app.close(); app = create(); await app.start()
    app.store.db.prepare("UPDATE effect SET due=0 WHERE kind='reply'").run()
    await app.pump()
    assert.equal(replies.size, 1)
    assert.equal(modelCalls, 1)
    assert.equal(server.calls.filter(call => call.method === 'thread/start').length, 1)
    assert.equal(app.store.db.prepare("SELECT COUNT(*) AS n FROM effect WHERE kind='reply'").get()?.n, 0)
    messages.push({ ...messages[0]!, id: 'another-goal', text: 'Now do an unrelated task' })
    await app.pump()
    server.finish(worker, 'completed', JSON.stringify({ action: 'handback', triggerId: elpisChatTriggerId('mother', 'another-goal'), reason: 'This goal is outside the first ticket' }))
    await app.pump()
    assert.equal(modelCalls, 2, 'The worker hands an unrelated follow-up back to Mother for routing')
    assert.equal(app.store.tickets.list().length, 2)
    assert.equal(server.calls.filter(call => call.method === 'thread/start').length, 2)
    assert.equal(replies.size, 1, 'An internal handback does not add a progress reply to the chat')
    const second = [...server.threads.keys()][1]!
    assert.doesNotThrow(() => server.finish(second, 'completed', '{"action":"handback","triggerId":"unrelated-trigger","reason":"Invalid output"}'))
    await app.pump()
    assert.equal(app.store.tickets.list()[0]?.assignments.at(-1)?.report?.state, 'failed', 'Invalid worker actions are reported without crashing the bridge')
  } finally { await app?.close(); rmSync(home, { recursive: true, force: true }) }
  assert.equal(server.connections.size, 0)
})

test('malformed dispatch never launches a worker or manufactures a successful reply', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mother-invalid-')), server = new FakeServer()
  const app = new MotherApp({ home, threadId: 'mother', settings: () => SettingsSchema.parse({}), adapters: [new ElpisAdapter(server.connect)],
    subprocess: { spawn: () => { throw new Error('Unexpected process') } }, dispatch: async () => ({ action: 'accept', title: 'Missing scope and name' }),
    transport: { read: async () => [{ id: 'bad', threadId: 'mother', role: 'user', actorId: 'me', at: new Date().toISOString(), text: 'Do it' }], appendAssistant: async () => { throw new Error('Unexpected success') } } })
  try {
    await app.start(); await app.pump()
    assert.equal(app.store.tickets.list().length, 0)
    assert.equal(server.calls.filter(call => call.method === 'thread/start').length, 0)
    const failed = app.store.db.prepare("SELECT attempts, error FROM effect WHERE kind='assessment'").get()
    assert.equal(failed?.attempts, 1); assert.ok(failed?.error)
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }) }
})
