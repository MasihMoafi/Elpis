// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/sources.spec.ts and outbox.spec.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixture } from '../fixtures/app.mts'
import { setTimeout as delay } from 'node:timers/promises'
import { SettingsSchema } from '../policy.mts'
import { subprocess } from '../subprocess.mts'
import { githubKind, pollRound } from './github.mts'
import { KV } from './kv.mts'
import { GH_UNSET } from '../infra/github-env.mts'

/** The executable boundary is fake; Commands, deployment, polling, Engine, native tools and receipts are real. */
test('saved gh login polls events and subscriptions, replays safely, and reports CI and merge to its owning worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mother-gh-')), state = join(dir, 'state.json'), log = join(dir, 'calls.jsonl')
  const pathBefore = process.env.PATH
  const at = new Date(Date.now() + 1000).toISOString()
  const update = (phase: number) => writeFileSync(state, JSON.stringify({ ...(phase ? JSON.parse(readFileSync(state, 'utf8')) as object : {}), phase, at }))
  update(0)
  const program = join(dir, 'gh')
  writeFileSync(program, `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, 'utf8'));
const args = process.argv.slice(2), path = (args[1] || '').split('?')[0];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, ambient: ${JSON.stringify(GH_UNSET)}.filter(key => process.env[key]) }) + '\\n');
const user = { login: 'bob', type: 'User' }, issue = number => ({ id: number, number, title: 'Inspect ' + number, state: 'open', body: '@agent-bot inspect this project', user, created_at: state.at, updated_at: state.at, html_url: 'https://github.com/acme/widgets/issues/' + number });
const pr = { ...issue(2), html_url: 'https://github.com/acme/widgets/pull/2', merged: state.phase >= 4, state: state.phase >= 4 ? 'closed' : 'open', merged_at: state.phase >= 4 ? state.at : null, head: { sha: 'abcdef1234567', ref: 'feature', repo: { full_name: 'acme/widgets' } }, base: { ref: 'main' } };
const comment = (id, body) => ({ id, body, user, created_at: state.at, updated_at: state.at, submitted_at: state.at, html_url: 'https://github.com/acme/widgets/pull/2#issuecomment-' + id, issue_url: 'https://api.github.com/repos/acme/widgets/issues/2', pull_request_url: 'https://api.github.com/repos/acme/widgets/pulls/2' });
let value;
if (args.includes('--method')) {
  if (args[args.indexOf('--method') + 1] !== 'POST' || !path.endsWith('/issues/2/comments')) throw new Error('Unexpected write');
  value = { id: 900, user: { login: 'agent-bot' }, body: args.find(arg => arg.startsWith('body=')).slice(5) };
  state.sent = [value]; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
}
else if (path === 'user') value = { login: 'agent-bot', id: 7 };
else if (path === 'repos/acme/widgets') value = { full_name: 'acme/widgets', permissions: { push: true }, default_branch: 'main' };
else if (path.endsWith('/notifications')) value = [];
else if (path.endsWith('/issues')) value = state.phase ? [issue(1), { ...issue(2), html_url: pr.html_url, pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/2' } }] : [];
else if (path.endsWith('/pulls/comments')) value = state.phase ? [{ ...comment(4, '@agent-bot fix this line'), path: 'src/app.ts', line: 5 }] : [];
else if (path.endsWith('/issues/comments')) value = state.phase ? [comment(3, '@agent-bot verify the change')] : [];
else if (path.endsWith('/issues/2')) value = { ...issue(2), pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/2' } };
else if (path.endsWith('/issues/1')) value = issue(1);
else if (path.endsWith('/pulls/2')) value = pr;
else if (path.endsWith('/issues/2/comments')) value = [...(state.sent || []), ...(state.phase >= 2 ? [comment(5, 'Now check the accessibility')] : [])];
else if (path.endsWith('/pulls/2/comments')) value = state.phase >= 2 ? [{ ...comment(6, 'Please handle this inline note'), path: 'src/app.ts', line: 9 }] : [];
else if (path.endsWith('/pulls/2/reviews')) value = state.phase >= 2 ? [{ ...comment(7, ''), state: 'APPROVED' }] : [];
else if (path.endsWith('/check-runs')) value = { check_runs: [{ name: 'build', status: 'completed', conclusion: state.phase === 3 ? 'failure' : 'success' }] };
else if (path.endsWith('/statuses')) value = [];
else if (path.includes('/commits/')) value = { sha: 'abcdef1234567' };
else throw new Error('Unexpected fake gh request: ' + args.join(' '));
if (args.includes('--slurp')) value = [value];
if (args.includes('--include')) process.stdout.write('HTTP/2 200 OK\\netag: "fixture"\\nx-poll-interval: 60\\n\\n');
process.stdout.write(JSON.stringify(value));
`)
  chmodSync(program, 0o755)
  process.env.PATH = `${dir}:${pathBefore ?? ''}`
  const h = fixture({ subprocess, settings: () => SettingsSchema.parse({
    eval: { model: { provider: 'openai', model: 'router' } }, executor: { model: { provider: 'openai', model: 'worker' } },
    sources: { github: { enabled: true, config: { repository: 'acme/widgets', observeIssues: true, observePulls: true, observeComments: true } } },
    policy: { sources: { github: { allowed: [{ id: 'bob' }] } } },
  }) })
  try {
    await h.app.start()
    for (let attempt = 0; h.app.health.github?.state !== 'ready' && attempt < 200; attempt++) await delay(10)
    assert.equal(h.app.health.github?.state, 'ready', h.app.health.github?.detail)
    assert.equal(h.app.setup.deployment.github.login, 'agent-bot')
    update(1)
    const ctx = h.app.context(githubKind)
    await pollRound(ctx); await h.app.pump()
    assert.deepEqual(new Set(h.app.store.read.recentTriggers().map(item => item.meta.kind)), new Set(['issue', 'pull', 'conversation', 'inline']))
    const count = h.app.store.read.recentTriggers().length
    await pollRound(ctx); await h.app.pump()
    assert.equal(h.app.store.read.recentTriggers().length, count)
    assert.ok(h.app.store.get(KV.github.stream('issues'))?.etag)
    const prTrigger = h.app.store.read.recentTriggers().find(item => item.meta.kind === 'pull')!
    await h.route(prTrigger.id); await h.app.pump()
    const ticket = h.app.store.tickets.list()[0]!, worker = h.app.workers.sessions.nativeId(`worker-${ticket.id}`)!
    await h.call(worker, 'orchestrator_report', { state: 'ready', summary: 'Ready for CI and review', pr_number: 2 })
    assert.equal(h.app.store.tickets.get(ticket.id)?.ended, undefined)
    await pollRound(ctx)
    update(2); await pollRound(ctx); await h.app.pump()
    assert.ok(h.app.store.read.recentTriggers().some(item => item.meta.kind === 'review' && item.text.includes('APPROVED')))
    assert.ok(h.app.store.tickets.get(ticket.id)?.inputs.some(input => input.kind === 'trigger' && h.app.store.triggers.get(input.triggerId)?.text.includes('accessibility')))
    update(3); await pollRound(ctx); await h.app.pump()
    assert.ok(h.app.store.read.recentTriggers().some(item => item.meta.ci === true && item.text.includes('failed')))
    assert.match(JSON.stringify(h.server.threads.get(worker)?.turns), /CI failed/)
    await h.call(worker, 'orchestrator_report', { state: 'ready', summary: 'Handled the follow-up and CI feedback', pr_number: 2 })
    update(4); await pollRound(ctx); await h.app.pump()
    assert.equal(h.app.store.tickets.get(ticket.id)?.ended?.outcome, 'merged')
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; ambient: string[] })
    assert.ok(calls.length > 15)
    assert.ok(calls.every(call => !call.ambient.length), 'Every gh invocation uses saved auth without token/proxy overrides')
    assert.equal(calls.filter(call => call.args.includes('--method')).length, 1, 'Only one acknowledgement is posted to the local fake gh')
    assert.ok(calls.some(call => call.args.some(arg => arg.startsWith('If-None-Match:'))))
  } finally {
    await h.close()
    if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore
    rmSync(dir, { recursive: true, force: true })
  }
})
