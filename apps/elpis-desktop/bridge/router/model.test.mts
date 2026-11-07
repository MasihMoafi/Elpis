import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelCatalog } from './model.mts'
import { EventEmitter } from 'node:events'
import { DesktopClient } from '../client.mts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('catalog uses configured connections without starting inference and keeps provider failures visible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mother-model-'))
  const client = new DesktopClient(Object.assign(new EventEmitter(), { close() {} }), { home: dir, appHome: dir })
  try {
  client.settings = async () => ({ main: { provider: 'openai', model: 'signed-in' }, providers: [{ id: 'openai', displayName: 'ChatGPT' }, { id: 'offline', displayName: 'Unavailable' }] }) as Awaited<ReturnType<DesktopClient['settings']>>
  client.models = async raw => { const input = raw as { provider: string }; if (input.provider === 'offline') throw new Error('Provider unavailable'); return { data: [{ model: 'signed-in', displayName: 'Signed in' }] } }
  client.sideRpc = async () => { throw new Error('A catalog must never start a turn') }
  const catalog = await modelCatalog(client)()
  assert.equal(catalog.groups[0]?.models[0]?.id, 'signed-in'); assert.equal(catalog.failures[0]?.provider, 'offline')
  } finally { client.close(); await rm(dir, { recursive: true, force: true }) }
})
