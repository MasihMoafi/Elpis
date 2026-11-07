// Ported from dsh-superagent (MIT), tests/sources.spec.ts, tests/registry.spec.ts and tests/admission-context.spec.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Commands, CliError } from '../infra/commands.mts'
import { testDeployment } from '../infra/fixtures.test.mts'
import { SourceRegistry } from './registry.mts'
import { githubKind } from './github.mts'
import { githubAddress, issueTrigger, CommentSchema, commentTrigger } from './github-trigger.mts'
import { sendGithub } from './github-channel.mts'
import { readGithub, pullChecks } from './github-read.mts'
import { admissionContext, threadWindow } from './admission-context.mts'
import type { OutboundMessage } from '../core/index.mts'

test('registry enforces source scope and preserves missing kinds', () => {
  const registry = new SourceRegistry(() => ({ sources: { github: { enabled: false, config: {} }, retired: { enabled: true, config: {} } }, policy: { sources: {} } }))
  const release = registry.register(githubKind)
  assert.deepEqual(registry.scope({ source: 'github', meta: {} }), { listened: false, reason: 'source_disabled' })
  assert.deepEqual(registry.scope({ source: 'retired', meta: {} }), { listened: false, reason: 'source_not_installed' })
  assert.throws(() => registry.register(githubKind), /already registered/)
  release()
  assert.equal(registry.kind('github'), undefined)
})

test('GitHub triggers distinguish humans, mentions, bots and repository addresses', () => {
  const issue = { number: 9, title: 'Fix', body: '@agent-bot please', user: { login: 'alice', type: 'User' }, created_at: '2026-01-01T00:00:00Z', html_url: 'https://github.com/acme/widgets/issues/9' }
  assert.equal(issueTrigger(issue, 'agent-bot').addressed, 'mention')
  const bot = CommentSchema.parse({ id: 7, body: '@agent-bot', user: { login: 'checker[bot]', type: 'Bot' } })
  assert.equal(commentTrigger(bot, { number: 9, isPr: false }, 'conversation', 'agent-bot').human, false)
  assert.deepEqual(githubAddress('https://github.com/acme/widgets/pull/9#discussion_r7', 'acme/widgets'), { number: 9, pr: true, discussion: 7 })
  assert.equal(githubAddress('https://github.com/other/widgets/pull/9', 'acme/widgets'), undefined)
})

test('GitHub delivery is idempotent and retries temporary failures', async () => {
  const commands = new Commands(testDeployment, {}, new AbortController().signal)
  const message: OutboundMessage = { id: 'r1', channel: { source: 'github', thread: 'github:9', address: { number: '9' } }, text: 'done', kind: 'reply' }
  let writes = 0
  commands.run = async (_program, args) => {
    if (args.includes('--method')) { writes++; return '{}' }
    return JSON.stringify([[{ id: 1, body: '<!-- dsh-superagent:r1 -->', user: { login: 'agent-bot' } }]])
  }
  assert.equal(await sendGithub({ commands }, message), 'sent')
  assert.equal(writes, 0)
  commands.run = async () => { throw new CliError('temporarily unavailable', 404) }
  await assert.rejects(sendGithub({ commands }, message), /temporarily unavailable/)
})

test('admission context bounds windows and refuses a repeated cursor', async () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({ id: String(i), from: 'u', at: '', text: String(i) }))
  const window = threadWindow(messages, '25')
  assert.equal(window.entries[5]?.omitted_before, 15)
  assert.equal(window.omitted_after, 9)
  const commands = new Commands(testDeployment, {}, new AbortController().signal)
  await assert.rejects(admissionContext({ messageId: '25', read: async () => ({ messages: [], body: {}, next: 'same' }), images: () => [], image: async () => undefined }, commands, 3), /repeated a cursor/)
})

test('GitHub reads paginate checks and reject unsupported paths without a request', async () => {
  const commands = new Commands(testDeployment, {}, new AbortController().signal)
  let calls = 0
  commands.run = async (_program, args) => {
    calls++
    if (args[1]?.includes('check-runs')) return JSON.stringify([{ check_runs: [{ name: 'z', status: 'completed', conclusion: 'success' }] }, { check_runs: [{ name: 'a', status: 'in_progress', conclusion: null }] }])
    if (args[1]?.includes('statuses')) return JSON.stringify([[{ context: 'build', state: 'success' }, { context: 'build', state: 'failure' }]])
    throw new Error('unexpected fixture request')
  }
  const snapshot = await pullChecks(commands, 'abc')
  assert.deepEqual(snapshot.checks.map(check => check.name), ['a', 'z'])
  assert.deepEqual(snapshot.statuses, [{ context: 'build', state: 'success' }])
  const before = calls
  for (const path of ['github/../outside', 'github/issues/1/reviews', 'github/pulls/1/checks/2']) await assert.rejects(readGithub(commands, path))
  assert.equal(calls, before)
})
