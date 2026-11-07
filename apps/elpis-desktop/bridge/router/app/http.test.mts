// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/http.spec.ts and settings.spec.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { fixture } from '../fixtures/app.mts'
import { handleMotherHttp } from './http.mts'

test('panel HTTP validates its boundary, exposes records, and persists revisioned settings and prompts without a model call', async () => {
  const h = fixture()
  let port = 0
  const server = createServer((req, res) => { void handleMotherHttp(h.app.http(), req, res, port) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string'); port = address.port
  function call(method: string, path: string, value?: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: `/api/mother/${path}`, method,
        headers: { 'x-orchestrator-request': '1', ...headers } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += String(chunk) })
        res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) as unknown }) } catch (error) { reject(error instanceof Error ? error : new Error(String(error))) } })
      })
      req.on('error', reject); req.end(value === undefined ? undefined : typeof value === 'string' ? value : JSON.stringify(value))
    })
  }
  try {
    for (const endpoint of ['state', 'overview', 'sources', 'threads', 'tickets', 'decisions', 'settings', 'prompts', 'models', 'policy/history', 'deployment']) {
      assert.equal((await call('GET', endpoint)).status, 200, endpoint)
    }
    for (const headers of [{ 'x-orchestrator-request': '' }, { host: 'evil.example' }, { origin: 'https://evil.example' }]) {
      assert.equal((await call('POST', 'executor/pause', { paused: true }, headers)).status, 403)
    }
    assert.equal(h.app.store.settings().paused, false)
    assert.equal((await call('POST', 'executor/pause', 'not json')).status, 400)
    assert.equal((await call('PUT', 'settings/executor', { revision: h.app.store.blockRevision('executor'), value: { prepare: 'x'.repeat(128 * 1024) } })).status, 400)
    assert.equal((await call('POST', 'tickets/missing/retry')).status, 404)
    assert.equal((await call('GET', 'threads/%GG')).status, 400)
    const current = h.app.store.settings(), revision = h.app.store.blockRevision('executor')
    const executor = { ...current.executor, maxWorkers: current.executor.maxWorkers + 1 }
    assert.equal((await call('PUT', 'settings/executor', { revision, value: executor })).status, 200)
    assert.equal((await call('PUT', 'settings/executor', { revision, value: executor })).status, 409)
    assert.equal((await call('PUT', 'settings/executor', { revision: h.app.store.blockRevision('executor'), value: { ...executor, maxWorkers: 'wrong' } })).status, 400)
    const prompt = h.app.prompts.current(), config = { ...prompt.config, communication: `${prompt.config.communication}\nUse focused checks.` }
    assert.equal((await call('PUT', 'prompts', { baseRevision: prompt.revision, config })).status, 200)
    assert.equal((await call('PUT', 'prompts', { baseRevision: prompt.revision, config })).status, 409)
    assert.equal((await call('PUT', 'deployment', { revision: 0, value: { admissionContextMaxPages: 3 } })).status, 200)
    assert.equal((await call('PUT', 'deployment', { revision: 0, value: {} })).status, 409)
    assert.equal((await call('PUT', 'deployment', { revision: 1, value: { promptMaxChars: -1 } })).status, 400)
    assert.equal(h.app.machine.admissionContextMaxPages.get(), 3)
    assert.equal(h.server.connections.size, 0)
    assert.equal(h.app.store.settings().executor.maxWorkers, executor.maxWorkers)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve())); await h.close() }
})
