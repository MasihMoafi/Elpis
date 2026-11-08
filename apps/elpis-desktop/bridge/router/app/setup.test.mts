// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/deployment.spec.ts and environment.spec.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture } from '../fixtures/app.mts';
import { SettingsSchema } from '../policy.mts';
import { agentVariables, GIT_LOCATION, workerBin } from '../infra/environment.mts';
import { subprocess } from '../subprocess.mts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const exec = promisify(execFile)

test('local-chat workers receive isolated git settings and blocked-command shims while GitHub is off', async () => {
  const h = fixture({ settings: () => SettingsSchema.parse({ executor: { blockedCommands: ['private-cli'] } }) })
  try {
    await h.app.start()
    const environment = h.app.setup.workerEnvironment(), bin = workerBin(h.app.machine.stateDir)
    assert.equal(environment.PATH?.split(':')[0], bin)
    const env = { ...process.env, ...environment }
    await assert.rejects(exec('private-cli', [], { env }), /blocked in this installation/)
    await assert.rejects(exec('gh', ['api', 'user'], { env }), /GitHub.*not configured/)
    const call = h.server.calls.find(call => call.method === 'thread/start')!
    assert.equal((call.params.config as Record<string, unknown>)['shell_environment_policy.set'] && environment.PATH,
      ((call.params.config as Record<string, unknown>)['shell_environment_policy.set'] as Record<string, unknown>).PATH)
  } finally { await h.close() }
})

test('a foreign command-shim file prevents native sessions from starting', async () => {
  const h = fixture()
  try {
    const bin = workerBin(h.app.machine.stateDir); mkdirSync(bin, { recursive: true }); writeFileSync(join(bin, 'foreign'), 'Operator file')
    await assert.rejects(h.app.start(), /not written by/)
    assert.equal(h.server.calls.filter(call => call.method === 'thread/start').length, 0)
  } finally { await h.close() }
})

test('prepare children and native shells exclude the host repository, git config and identity', async () => {
  const h = fixture()
  const removed = Object.entries(agentVariables(h.app.machine.stateDir)).filter(([, value]) => value === undefined).map(([name]) => name)
  const previous = Object.fromEntries([...removed, 'GIT_CEILING_DIRECTORIES'].map(name => [name, process.env[name]]))
  try {
    for (const name of removed) process.env[name] = 'host-marker'
    process.env.GIT_CEILING_DIRECTORIES = h.home
    await h.app.start()
    const env = h.app.setup.workerEnvironment()
    const job = subprocess.spawn({ argv: [process.execPath, '-e', 'console.log(JSON.stringify(process.env))'], cwd: h.home, env,
      signal: AbortSignal.timeout(5000), graceMs: 100, stdio: { stdin: 'ignore', stdout: { maxBytes: 1 << 20 }, stderr: { maxBytes: 1000 } } })
    assert.equal((await job.done).exitCode, 0)
    const child: unknown = JSON.parse(job.collected.stdout!.readFrom(0).text)
    assert.ok(child && typeof child === 'object')
    for (const name of removed) assert.equal(Reflect.get(child, name), undefined, name)
    assert.equal(Reflect.get(child, 'GIT_CEILING_DIRECTORIES'), h.home)
    assert.equal(Reflect.get(child, 'GIT_CONFIG_GLOBAL'), env.GIT_CONFIG_GLOBAL)
    const config = h.server.calls.find(call => call.method === 'thread/start')!.params.config as Record<string, unknown>
    const excludes = config['shell_environment_policy.exclude'] as string[]
    for (const name of GIT_LOCATION) assert.ok(excludes.includes(name), name)
    const values = config['shell_environment_policy.set'] as Record<string, unknown>
    for (const name of removed) assert.equal(name in values, false, name)
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await h.close()
  }
})

test('enabling a saved GitHub source resolves its account before admitting work', async () => {
  const h = fixture({ subprocess: { spawn: ({ argv }) => ({ done: Promise.resolve({ exitCode: 0 }), collected: { stdout: { readFrom: () => ({ text: JSON.stringify(argv.at(-1) === 'user' ? { login: 'agent-bot', id: 7 } : { full_name: String(argv.at(-1)).replace('repos/', '') }) }) } } }) }, settings: () => SettingsSchema.parse({ sources: { github: { enabled: false, config: { repository: 'example/project' } } },
    eval: { model: { provider: 'openai', model: 'router' } }, executor: { model: { provider: 'openai', model: 'worker' } } }) })
  try {
    await h.app.start()
    assert.equal(h.app.setup.githubReady(), false)
    for (const repository of ['example/project', 'example/other']) {
      const before = h.app.store.settings().sources.github!
      const result = await h.app.settings.save('source:github', { ...before, enabled: true, config: { ...before.config, repository } }, h.app.store.blockRevision('source:github'), 'panel')
      assert.equal(result.restarting, true)
      await h.restart()
      assert.equal(h.app.setup.githubReady(), true)
      assert.equal(h.app.setup.deployment.repository, repository)
      assert.equal(h.app.context({ kind: 'github', health: ['github'] }).configured(), true)
      const enabled = h.app.store.settings().sources.github!
      await h.app.settings.save('source:github', { ...enabled, enabled: false }, h.app.store.blockRevision('source:github'), 'panel')
      await h.restart()
      assert.equal(h.app.context({ kind: 'github', health: ['github'] }).configured(), false)
    }
  } finally { await h.close() }
})
