// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/outbox.spec.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { fixture } from './fixtures/app.mts'
import type { OutboundMessage } from './core/index.mts'

test('pause holds replies and a late source registration drains its durable pending receipt once', async () => {
  const h = fixture(), sent: OutboundMessage[] = []
  try {
    await h.app.start()
    await h.app.settings.pause(true, 'panel')
    h.app.outbox.send({ id: 'held', channel: { source: 'elpis-chat', thread: 'elpis-chat:mother', address: { threadId: 'mother' } }, text: 'Done', kind: 'notice' })
    await h.app.pump(); assert.equal(h.app.outbox.status('held'), 'pending'); assert.equal(h.replies.size, 0)
    await h.app.settings.pause(false, 'panel'); await h.app.pump()
    assert.equal(h.app.outbox.status('held'), 'sent'); assert.equal(h.replies.size, 1)
    h.app.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Ready', kind: 'reply' })
    await h.app.pump(); assert.equal(h.app.outbox.status('waiting'), 'pending')
    h.app.sources.register({ kind: 'probe', title: { en: 'Probe', zh: 'Probe' }, description: { en: '', zh: '' }, schema: z.object({}), fields: [], health: [],
      channel: { send: async (_host, message) => { sent.push(message); return 'sent' }, link: () => ({ url: '', label: { en: '', zh: '' } }) } })
    h.app.store.db.prepare("UPDATE effect SET due=0 WHERE kind='reply'").run(); await h.app.pump()
    assert.equal(h.app.outbox.status('waiting'), 'sent'); assert.deepEqual(sent.map(message => message.id), ['waiting'])
    h.app.outbox.send({ id: 'waiting', channel: { source: 'probe', thread: 'probe:1', address: {} }, text: 'Duplicate', kind: 'reply' }); await h.app.pump()
    assert.equal(sent.length, 1)
  } finally { await h.close() }
})
