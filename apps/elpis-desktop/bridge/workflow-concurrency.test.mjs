import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { startDesktopServer } from './server.mjs';
import { readWorkflowConcurrency } from './resources/workflow-concurrency.mjs';

const { createTestTempDir, removeTestTempDir } = createRequire(import.meta.url)('../tests/temp-root.cjs');
test('workflow concurrency is authenticated, persisted, and rejects invalid choices', async t => {
  const home = createTestTempDir(path.join(os.tmpdir(), 'workflow-setting-'));
  t.after(() => removeTestTempDir(home));
  const client = new EventEmitter(); client.close = () => {};
  const bridge = await startDesktopServer({ client, elpisHome: home, loveSpot: { directory: path.join(home, 'love') }, trashFile: path.join(home, 'trash.json') });
  t.after(() => bridge.close());
  const url = new URL(bridge.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  assert.equal((await fetch(`${origin}/api/workflows/concurrency`)).status, 401);
  const session = await fetch(`${origin}/api/session`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  const headers = { cookie: session.headers.get('set-cookie').split(';')[0], origin, 'content-type': 'application/json' };
  const get = () => fetch(`${origin}/api/workflows/concurrency`, { headers });
  const post = value => fetch(`${origin}/api/workflows/concurrency`, { method: 'POST', headers, body: JSON.stringify({ value }) });
  assert.deepEqual(await (await get()).json(), { value: 4, choices: [1, 2, 3, 4] });
  assert.equal((await post(9)).status, 400);
  assert.equal(readWorkflowConcurrency(home), 4);
  assert.deepEqual(await (await post(2)).json(), { value: 2, choices: [1, 2, 3, 4] });
  assert.equal(readWorkflowConcurrency(home), 2);
});
