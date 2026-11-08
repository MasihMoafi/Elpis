// Real ACP bridge and provider process with scripted protocol peers; no provider or GitHub calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { ClaudeAdapter, ElpisAdapter, object, type Connection, type ToolBinding } from './adapters.mts'
import { ExecutorStore } from './store.mts'
import { ToolRuntime } from './tool-runtime.mts'
import { tool } from '../app/tools/tool.mts'

const tools = new URL('../../../../../tools/elpis-claude/', import.meta.url)
const connectAppServer: (options: { url: string; name: string }) => Connection = (await import(new URL('app-server-connection.mts', tools).href)).connectAppServer
async function wait(check: () => Promise<boolean>, description: string) {
  const end = Date.now() + 8000
  while (!await check()) { assert.ok(Date.now() < end, description); await delay(10) }
}

for (const native of [false, true]) test(`${native ? 'Native-to-Claude switch' : 'Claude role'} receives Elpis tools and reloads the same conversation with the next prompt revision`, { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mother-acp-')), log = join(root, 'bridge.log'), trace = join(root, 'acp.jsonl')
  const config = join(root, 'config.json')
  await writeFile(config, JSON.stringify({ config: { features: { multi_agent: false }, mcp_servers: {} } }))
  const child = spawn(process.execPath, [fileURLToPath(new URL('acp-bridge.mts', tools))], { cwd: root, stdio: ['pipe', 'ignore', 'pipe'], env: {
    PATH: process.env.PATH, HOME: root, ELPIS_HOME: join(root, 'elpis'), CODEX_HOME: join(root, 'elpis'), CODEX_AUTH_HOME: join(root, 'elpis'), XDG_RUNTIME_DIR: root,
    ELPIS_ENGINE_BIN: fileURLToPath(new URL('test/fake-app-server.mts', tools)), ACP_ADAPTER: fileURLToPath(new URL('test/fake-acp-agent.mts', tools)),
    ACP_BRIDGE_LOG: log, ACP_BRIDGE_STORE: join(root, 'sessions.json'), ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1', PORT: '0',
    FAKE_ENGINE_CONFIG: config, FAKE_ACP_LOG: trace, FAKE_ACP_MODELS: 'sonnet',
  } })
  let errors = '', adapter: ClaudeAdapter | ElpisAdapter | undefined, connection: Connection | undefined
  child.stderr.on('data', chunk => { errors += String(chunk) })
  const store = new ExecutorStore(join(root, 'router')), runtime = new ToolRuntime(store, root), lifetime = new AbortController()
  const definitions = [tool({ name: 'orchestrator_probe', description: 'Scoped evidence', schema: z.object({}).strict(), execute: async () => 'evidence' })]
  const records = async () => (await readFile(trace, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map((line): Record<string, unknown> => JSON.parse(line))
  try {
    let port: string | undefined
    await wait(async () => { port = /LISTENING (\d+)/.exec(await readFile(log, 'utf8').catch(() => ''))?.[1]; return !!port }, `ACP bridge starts: ${errors}`)
    const connect = () => connection = connectAppServer({ url: `ws://127.0.0.1:${port}`, name: 'mother-acp-proof' })
    adapter = native ? new ElpisAdapter(connect) : new ClaudeAdapter(connect)
    const mcp = await runtime.transport('main', definitions, 'orchestrator')
    let instructions = 'MOTHER_REVISION_ONE'
    const environment = { PATH: '/managed/bin:/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/managed/gitconfig' }
    const binding: ToolBinding = { tools: () => definitions, instructions: () => instructions, signal: lifetime.signal, authorize() {},
      mcp: () => Promise.resolve(mcp), environment: () => environment }
    const session = await adapter.open({ cwd: root, name: 'Elpis ACP', model: native ? { provider: 'openai', model: 'luna-test' } : { provider: 'claude', model: 'sonnet' }, role: 'orchestrator', tools: definitions, instructions, ...(!native ? { mcp } : {}), environment })
    runtime.bind('main', binding); adapter.bind(session.threadId, binding)
    if (native) { assert.ok(connection); await connection.call('thread/settings/update', { threadId: session.threadId, model: 'claude/sonnet' }) }
    let completed = 0
    adapter.subscribe(session.threadId, raw => { if (object(raw).method === 'turn/completed') completed++ })
    await adapter.send(session.threadId, 'first', 'Read current instructions.', null)
    await wait(async () => completed === 1, `first ACP turn completes: ${errors}`)
    instructions = 'MOTHER_REVISION_TWO'
    await adapter.send(session.threadId, 'second', 'Read the updated instructions.', null)
    await wait(async () => completed === 2, `second ACP turn completes: ${errors}`)
    const sessions = (await records()).filter(record => ['session/new', 'session/load'].includes(String(record.method)) && (JSON.stringify(object(record.params)._meta) ?? '').includes('MOTHER_REVISION_'))
    assert.equal(sessions.length, 2)
    assert.match(JSON.stringify(object(sessions[0]!.params)._meta), /MOTHER_REVISION_ONE/)
    assert.match(JSON.stringify(object(sessions[1]!.params)._meta), /MOTHER_REVISION_TWO/)
    assert.doesNotMatch(JSON.stringify(object(sessions[1]!.params)._meta), /MOTHER_REVISION_ONE/)
    assert.match(JSON.stringify(object(sessions[1]!.params).mcpServers), /elpis_mother/)
    const options = object(object(object(sessions[1]!.params)._meta).claudeCode).options
    assert.deepEqual(object(options).env, { PATH: '/managed/bin:/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/managed/gitconfig', ELPIS_MOTHER_ROLE: 'orchestrator', GH_TOKEN: '', GITHUB_TOKEN: '' })
    assert.deepEqual(object(options).tools, [])
    assert.equal((object(sessions[1]!.params).mcpServers as unknown[]).length, 1, 'Only Elpis supplies the main role tools')
    const ids = (await records()).filter(record => record.method === 'session/prompt').map(record => object(record.params).sessionId)
    assert.equal(new Set(ids).size, 1, 'Prompt reload retains the provider conversation')
  } finally {
    lifetime.abort(); adapter?.close(); await runtime.close(); store.close()
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 1500); await exited; clearTimeout(timer) }
    await rm(root, { recursive: true, force: true })
  }
})
