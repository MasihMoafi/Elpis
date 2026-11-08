'use strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawn, spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { once }: typeof import('node:events') = require('node:events');
const { test }: typeof import('node:test') = require('node:test');
const { createTestTempDir, removeTestTempDir }: typeof import('../apps/elpis-desktop/tests/temp-root.cts') = require('../apps/elpis-desktop/tests/temp-root.cts');
const { writeSharedProviderAgyFixture }: typeof import('./lib/shared-provider-agy.cts') = require('./lib/shared-provider-agy.cts');

test('shared Gemini fixture handles model discovery and a held stream prompt', { timeout: 10000 }, async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'elpis-shared-agy-'));
  const agy = path.join(root, 'agy.cjs'), calls = path.join(root, 'calls.jsonl');
  const control = path.join(root, 'control.json');
  const files = { ready: path.join(root, 'ready'), release: path.join(root, 'release'), marker: path.join(root, 'marker') };
  fs.writeFileSync(control, JSON.stringify(files));
  writeSharedProviderAgyFixture(agy, calls);
  const env = { PATH: process.env.PATH, PERMISSION_FIXTURE_CONTROL: control };
  let child: ChildProcessWithoutNullStreams | undefined;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    removeTestTempDir(root);
  });

  const models = spawnSync(agy, ['models'], { cwd: root, env, encoding: 'utf8', timeout: 3000 });
  assert.equal(models.status, 0, models.stderr);
  assert.equal(models.stdout, 'gemini-3.8-flash-medium\tGemini fixture\n');
  assert.equal(fs.existsSync(calls), false, 'model discovery is not a prompt');

  const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', 'gemini-3.8-flash-medium', '--print='];
  child = spawn(agy, args, { cwd: root, env, stdio: 'pipe' });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!ready()) {
      assert.equal(child?.exitCode, null, `fixture exited: ${stderr}`);
      assert.ok(Date.now() < deadline, `fixture timed out: ${stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await until(() => stdout.includes('\n'));
  const init = JSON.parse(stdout.trim()) as { event: string; conversation_id: string };
  assert.equal(init.event, 'init');
  assert.ok(init.conversation_id);
  assert.equal(fs.existsSync(files.ready), false, 'the provider is not ready before a prompt');

  const prompt = JSON.stringify({ event: 'user', message: { content: 'held task' } });
  child.stdin.write(prompt + '\n');
  await until(() => fs.existsSync(files.ready));
  assert.equal(fs.existsSync(files.marker), false, 'held work must not complete before release');
  assert.deepEqual(JSON.parse(fs.readFileSync(calls, 'utf8').trim()), { method: 'agy/prompt', args: [...args, '--agy-fixture'], input: prompt });
  fs.writeFileSync(files.release, 'release');
  await until(() => stdout.split('\n').filter(Boolean).length === 2);
  assert.deepEqual(JSON.parse(stdout.split('\n')[1]), { event: 'result', result: { status: 'SUCCESS' } });
  assert.equal(fs.readFileSync(files.marker, 'utf8'), 'allowed');
  child.stdin.end();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, stderr);
});
