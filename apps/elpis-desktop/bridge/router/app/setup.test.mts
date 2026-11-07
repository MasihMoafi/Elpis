// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/deployment.spec.ts and environment.spec.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fixture } from '../fixtures/app.mts'
import { SettingsSchema } from '../policy.mts'
import { workerBin } from '../infra/environment.mts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
