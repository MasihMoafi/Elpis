// Ported from dsh-superagent (MIT), tests/sources.spec.ts (shape)
import { test } from 'node:test';
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DesktopClient } from '../../client.mts';
import { ElpisChatHistory } from './elpis-chat-history.mts';
import { createElpisChatTransport } from './elpis-chat-transport.mts';
import { mergeLiveItem } from '../../../lib/live-events.ts';
import type { Entry } from '../../../lib/api.ts';
import { chatContext } from './elpis-chat-read.mts';
import { issueTrigger } from './github-trigger.mts';
import { Commands } from '../infra/commands.mts';
import { testDeployment } from '../infra/fixtures.mts';

const CHAT = '00000000-0000-0000-0000-000000000001'
const user = (id: string) => ({ turnId: 'turn', item: { id, type: 'userMessage', content: [{ type: 'text', text: `user ${id}` }] }, startedAtMs: 1794009600000 })

test('desktop history transport reads native pages in intake order and stops at the durable message identity', async () => {
  const cursors: (string | undefined)[] = []
  const transport = createElpisChatTransport({
    async readThread(thread, options) {
      cursors.push(options.cursor)
      return { thread: { id: thread }, data: options.cursor ? [user('1')] : [user('3'), { turnId: 'turn', item: { id: 'tool', type: 'commandExecution' } }, user('2')], nextCursor: options.cursor ? null : 'older' }
    }, appendAssistant: async () => 'sent',
  })
  const messages = await transport.read(CHAT, undefined)
  assert.deepEqual(messages.map(item => [item.id, item.role, item.actorId, item.text]), [
    ['turn:1', 'user', 'local-user', 'user 1'], ['turn:2', 'user', 'local-user', 'user 2'], ['turn:3', 'user', 'local-user', 'user 3'] ])
  assert.equal(messages[0]?.at, '2026-11-07T00:00:00.000Z')
  cursors.length = 0
  assert.deepEqual((await transport.read(CHAT, 'turn:2')).map(item => item.id), ['turn:3'])
  assert.deepEqual(cursors, [undefined])
  assert.deepEqual((await transport.read(CHAT, 'deleted')).map(item => item.id), ['turn:1', 'turn:2', 'turn:3'])
})

test('history transport refuses another chat, repeated cursors, malformed user content, and aborted reads', async () => {
  const client = { readThread: async () => ({ thread: { id: CHAT }, data: [user('1')], nextCursor: 'same' }), appendAssistant: async (): Promise<'sent'> => 'sent' }
  const transport = createElpisChatTransport(client)
  await assert.rejects(transport.read(CHAT, undefined), /repeated a cursor/)
  await assert.rejects(transport.read('other', undefined), /another chat/)
  await assert.rejects(transport.read(CHAT, undefined, AbortSignal.abort()), /abort/i)
  const malformed = createElpisChatTransport({ ...client, readThread: async () => ({ thread: { id: CHAT }, data: [{ ...user('1'), item: { id: '1', type: 'userMessage', content: 'bad' } }] }) })
  await assert.rejects(malformed.read(CHAT, undefined), /array/)
})

test('chat images survive durable history and bounded reads only expose the image in the requested message', async () => {
  const home = mkdtempSync(join(tmpdir(), 'mother-images-'))
  try {
    const history = new ElpisChatHistory(home), url = 'data:image/png;base64,iVBORw0KGgo='
    history.append(CHAT, { id: 'image', text: 'Inspect the screenshot', content: [{ type: 'text', text: 'Inspect the screenshot' }, { type: 'image', url }] }, '', 'user')
    const entries = new ElpisChatHistory(home).merge(CHAT, { data: [] })
    const transport = createElpisChatTransport({ readThread: async () => ({ thread: { id: CHAT }, data: entries }), appendAssistant: async () => 'sent' })
    const messages = await transport.read(CHAT, undefined), message = messages[0]!
    assert.match(message.text, /\[image:image-1\]/); assert.equal(message.images?.[0]?.url, url)
    const trigger = { ...issueTrigger({ number: 1, title: 'Image', body: '', html_url: 'https://example.test/image', user: { login: 'user' }, created_at: new Date().toISOString() }, 'mother'), source: 'elpis-chat', meta: { threadId: CHAT, messageId: message.id } }
    const context = chatContext(transport), commands = new Commands(testDeployment, {}, new AbortController().signal)
    assert.deepEqual(await context.image?.({}, commands, trigger, { id: message.id, text: message.text }, 'image-1', home, new AbortController().signal), { image_url: url })
    await assert.rejects(context.image!({}, commands, trigger, { id: 'another-message', text: message.text }, 'image-1', home, new AbortController().signal), /unavailable/)
    await assert.rejects(context.image!({}, commands, trigger, { id: message.id, text: message.text }, 'image-1', home, AbortSignal.abort()), /abort/i)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('reply insertion is durable and immutable per thread and ID, and merges into the native anchor page', () => {
  const home = mkdtempSync(join(tmpdir(), 'chat-history-'))
  try {
    const history = new ElpisChatHistory(home)
    // A crash immediately after creating the database must not break ordinary chat reads.
    mkdirSync(join(home, 'router'))
    new DatabaseSync(join(home, 'router', 'chat-replies.sqlite')).close()
    assert.deepEqual(history.merge(CHAT, { data: [user('1')] }), [user('1')])
    history.append(CHAT, { id: 'r1', text: 'Result' }, 'turn:1')
    history.append(CHAT, { id: 'r2', text: 'Permission?' }, 'turn:1')
    const reopened = new ElpisChatHistory(home)
    reopened.append(CHAT, { id: 'r1', text: 'edited retry' }, 'turn:2')
    reopened.append('other', { id: 'r1', text: 'Elsewhere' }, '')
    assert.deepEqual(reopened.merge(CHAT, { data: [user('2')], nextCursor: 'older' }).map(item => item.item.id), ['2'])
    const page = reopened.merge(CHAT, { data: [user('1')], nextCursor: null })
    assert.deepEqual(page.map(item => item.item.id), ['r2', 'r1', '1'])
    assert.equal(page[1] && 'text' in page[1].item ? page[1].item.text : '', 'Result')
    assert.equal(statSync(join(home, 'router', 'chat-replies.sqlite')).mode & 0o777, 0o600)
    assert.deepEqual(reopened.merge('other', { data: [], nextCursor: null }).map(item => item.item.id), ['r1'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('real DesktopClient append and read keep one assistant reply after a restart, without model RPCs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'chat-client-')), clients: DesktopClient[] = [], calls: string[] = []
  let writable = true, deleted = false
  function client() {
    const socket = Object.assign(new EventEmitter(), { close() {}, send(raw: string) {
      const request = JSON.parse(raw) as { id?: string; method: string; params: { cursor?: string } }
      if (!request.id) return
      calls.push(request.method)
      let result: object
      if (request.method === 'initialize') result = {}
      else if (request.method === 'thread/read') {
        if (deleted) { queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: `thread not found: ${CHAT}` } }))); return }
        result = { thread: { id: CHAT, status: { type: 'idle' }, canAcceptDirectInput: writable } }
      } else if (request.method === 'thread/items/list') result = { data: request.params.cursor ? [user('1')] : [user('2')], nextCursor: request.params.cursor ? null : 'older' }
      else throw new Error(`Unexpected RPC: ${request.method}`)
      queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })))
    } })
    const value = new DesktopClient(socket, { home, appHome: home }); clients.push(value); return value
  }
  try {
    const first = client(); await first.initialize()
    let visible: Entry[] = []
    first.on('event', (event: { type: string; data: { method: string; params: Record<string, unknown> } }) => {
      if (event.type === 'message') visible = mergeLiveItem(visible, event.data.method, event.data.params, CHAT)
    })
    const transport = createElpisChatTransport(first)
    await Promise.all([transport.appendAssistant(CHAT, { id: 'r1', text: 'May I start the helper?' }), transport.appendAssistant(CHAT, { id: 'r1', text: 'duplicate' })])
    assert.equal(visible.length, 1)
    assert.equal(visible[0]?.item.type, 'agentMessage')
    assert.equal(visible[0]?.item.text, 'May I start the helper?')
    first.close()
    const reopened = client(); await reopened.initialize()
    await reopened.appendAssistant(CHAT, { id: 'r1', text: 'retry' })
    const page = await reopened.readThread(CHAT)
    assert.deepEqual(page.data.map(item => [item.item.type, item.item.id]), [['agentMessage', 'r1'], ['userMessage', '2']])
    assert.equal(page.data[0]?.item.text, 'May I start the helper?')
    assert.deepEqual((await createElpisChatTransport(reopened).read(CHAT, undefined)).map(item => item.role), ['user', 'user', 'assistant'])
    writable = false; await assert.rejects(reopened.appendAssistant(CHAT, { id: 'r2', text: 'denied' }), /parent/)
    await assert.rejects(createElpisChatTransport(reopened).appendAssistant(CHAT, { id: 'r2', text: 'denied' }), /parent/)
    writable = true; deleted = true; await assert.rejects(reopened.appendAssistant(CHAT, { id: 'r2', text: 'gone' }), /thread not found/)
    assert.equal(await createElpisChatTransport(reopened).appendAssistant(CHAT, { id: 'r2', text: 'gone' }), 'gone', 'A deleted source conversation must settle its outbox receipt instead of retrying forever')
    assert.ok(calls.every(method => ['initialize', 'thread/read', 'thread/items/list'].includes(method)))
  } finally { for (const value of clients) value.close(); rmSync(home, { recursive: true, force: true }) }
})
