import { createTestTempDir, removeTestTempDir } from '../tests/temp-root.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { startDesktopServer } from './server.mjs';

async function fixture(t) {
  const cache = path.join(os.homedir(), '.cache', 'elpis-tests');
  await fs.mkdir(cache, { recursive: true });
  const home = createTestTempDir(path.join(cache, 'request-diagnostics-'));
  let failure;
  const client = Object.assign(new EventEmitter(), { close() {}, async models() { throw failure; }, async saveSettings() { throw failure; } });
  const app = await startDesktopServer({ client, elpisHome: home, trashFile: path.join(home, 'trash.json') });
  t.after(async () => { await app.close(); removeTestTempDir(home); });
  const launch = new URL(app.url), origin = launch.origin;
  const session = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: launch.hash.slice(7) }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  return { home, async fail(error, write = false) {
    failure = error;
    return fetch(origin + (write ? '/api/settings' : '/api/models?cursor=PRIVATE_QUERY'), {
      method: write ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie, 'X-Request-Id': 'PRIVATE_HEADER' },
      ...(write ? { body: JSON.stringify({ text: 'PRIVATE_BODY', key: 'sk-secret-token' }) } : {}),
    });
  } };
}

test('unexpected failures correlate a sanitized local record with the HTTP code and request ID', async t => {
  const f = await fixture(t);
  const error = Object.assign(new TypeError('PRIVATE_MESSAGE sk-secret-token'), { code: 'PRIVATE_CODE', engineMessage: 'PRIVATE_ENGINE', cause: new Error('PRIVATE_CAUSE') });
  const response = await f.fail(error), body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.error, 'Application request failed');
  assert.equal(body.code, 'ELPIS_REQUEST_FAILED');
  assert.match(body.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get('x-request-id'), body.requestId);
  const file = path.join(f.home, 'logs', 'desktop-requests.jsonl');
  const records = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], { at: records[0].at, requestId: body.requestId, method: 'GET', area: 'models', status: 500, code: body.code, cause: 'TypeError' });
  assert.ok(Number.isFinite(Date.parse(records[0].at)));
  assert.doesNotMatch(JSON.stringify(records) + JSON.stringify(body), /PRIVATE|sk-secret/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const next = await (await f.fail(error)).json();
  assert.notEqual(next.requestId, body.requestId);
  await f.fail(error, true);
  assert.doesNotMatch(await fs.readFile(file, 'utf8'), /PRIVATE|sk-secret/);
});

test('native error codes survive HTTP and unknown write delivery is never called retryable', async t => {
  const f = await fixture(t);
  const native = Object.assign(new BridgeError('Elpis rejected the operation (-32603). No automatic retry was made.', 502), { code: -32603, engineMessage: 'PRIVATE_ENGINE' });
  const response = await f.fail(native), body = await response.json();
  assert.equal(body.code, 'ELPIS_RUNTIME_ERROR');
  assert.equal(body.runtimeCode, -32603);
  const delivery = await (await f.fail(new BridgeError('Elpis connection closed. The request outcome is unknown. No automatic retry was made.', 503))).json();
  assert.match(delivery.error, /outcome is unknown/);
  assert.match(delivery.error, /No automatic retry/);
  assert.equal(delivery.code, 'ELPIS_RUNTIME_UNAVAILABLE');
  assert.doesNotMatch(await fs.readFile(path.join(f.home, 'logs', 'desktop-requests.jsonl'), 'utf8'), /PRIVATE|outcome/);
});

test('diagnostic retention is bounded and a broken log directory does not hide the request failure', async t => {
  const f = await fixture(t), logs = path.join(f.home, 'logs'), file = path.join(logs, 'desktop-requests.jsonl');
  await fs.mkdir(logs);
  await fs.writeFile(file, 'x'.repeat(1024 * 1024), { mode: 0o600 });
  assert.equal((await f.fail(new Error('secret'))).status, 500);
  assert.ok((await fs.stat(file)).size < 1024, 'the active log is reset at 1 MiB');
  await fs.rename(logs, path.join(f.home, 'old-logs'));
  await fs.writeFile(logs, 'not a directory');
  const response = await f.fail(new Error('secret')), body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(body.code, 'ELPIS_REQUEST_FAILED');
  assert.match(body.requestId, /^[a-f0-9-]{36}$/);
});
