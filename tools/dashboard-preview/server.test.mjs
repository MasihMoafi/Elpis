import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./server.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('../../codex-rs/tui/src/dashboard_assets/fixtures/activity-state.json', import.meta.url));
async function freePort() {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function start(t, mode) {
  const port = await freePort();
  const child = spawn(process.execPath, [script, ...mode, '--port', String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw new Error('preview exited'); })]);
  return port;
}
function get(port, path, host = `127.0.0.1:${port}`, method = 'GET') {
  return new Promise((resolve, reject) => {
    request({ hostname: '127.0.0.1', port, path, method, headers: { Host: host } }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    }).on('error', reject).end();
  });
}
test('fixture is labelled; local assets work; external Host cannot read data', { timeout: 5000 }, async t => {
  const port = await start(t, ['--fixture', fixture]);
  const page = await get(port, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, /Illustrative fixture/);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal((await get(port, '/dashboard.js')).status, 200);
  const data = await get(port, '/data.json');
  assert.equal(data.status, 200);
  const envelope = JSON.parse(data.body);
  assert.ok(Math.abs(Date.now() - envelope.heartbeat_at) < 2000, 'heartbeat uses milliseconds');
  assert.ok(Date.now() - envelope.state.activity.current.started_at < 10000, 'fixture retains its five-second age');
  assert.equal((await get(port, '/data.json', 'attacker.example')).status, 403);
  assert.equal((await get(port, '/missing')).status, 404);
  assert.equal((await get(port, '/', `127.0.0.1:${port}`, 'POST')).status, 405);
});
test('unavailable live data never falls back to fixtures', { timeout: 5000 }, async t => {
  const missingPort = await freePort();
  const port = await start(t, ['--live', `http://127.0.0.1:${missingPort}/data.json`]);
  const data = await get(port, '/data.json');
  assert.equal(data.status, 503);
  assert.deepEqual(JSON.parse(data.body), { state: null, heartbeat_at: null });
  assert.match((await get(port, '/')).body, /Local live data/);
});
test('missing, duplicate, unknown and conflicting options are rejected before listening', { timeout: 5000 }, async () => {
  for (const args of [[], ['--fixture', '--port', '43129'], ['--fixture', fixture, '--fixture', fixture],
    ['--fixture', fixture, '--typo', 'value'], ['--fixture', fixture, '--live', 'http://127.0.0.1:1/data.json']]) {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 500);
    const [code] = await once(child, 'exit');
    clearTimeout(timer);
    assert.equal(code, 2, `expected argument rejection: ${args.join(' ')}`);
  }
});
