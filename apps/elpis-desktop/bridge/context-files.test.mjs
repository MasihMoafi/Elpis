import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopClient } from './client.mjs';
import { startDesktopServer } from './server.mjs';
const ID = '00000000-0000-0000-0000-000000000001';
function fixture({ unsupported = false } = {}) {
  const socket = new EventEmitter(), sent = [];
  const files = [{ name: 'ES.md', path: '/tmp/project/ES.md', group: 'sessionContinuity', estimatedTokens: 20, included: true, reason: 'Checkpoint', selectable: true }];
  socket.send = raw => {
    const request = JSON.parse(raw); if (!request.id) return; sent.push(request);
    let result = {};
    if (request.method === 'thread/contextFiles/list' || request.method === 'thread/contextFiles/set') {
      if (unsupported) { queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: 'Invalid request: unknown variant `'+request.method+'`' } }))); return; }
      if (request.method.endsWith('/set')) {
        if (request.params.path !== files[0].path) { queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, error: { code: -32600, message: 'Unknown context source' } }))); return; }
        files[0].included = request.params.included;
      }
      result = { files: structuredClone(files) };
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  socket.close = () => {};
  return { client: new DesktopClient(socket), sent, files };
}
test('context files use the engine discovery and admission RPCs, returning its refreshed list', async t => {
  const { client, sent, files } = fixture(); t.after(() => client.close()); await client.initialize();
  assert.deepEqual(await client.contextFiles(ID), { files });
  for (const included of [false, true, false, true]) {
    assert.equal((await client.setContextFile(ID, { path: files[0].path, included })).files[0].included, included);
    assert.deepEqual(sent.at(-1).params, { threadId: ID, path: files[0].path, included });
    assert.equal(sent.at(-1).method, 'thread/contextFiles/set');
  }
  files[0].included = false; assert.equal((await client.contextFiles(ID)).files[0].included, false);
  assert.equal(sent[1].method, 'thread/contextFiles/list');
  await assert.rejects(client.setContextFile(ID, { path: '/unknown', included: true }), error => error.code === -32600);
});
test('context files validate thread, path and boolean before forwarding writes', async t => {
  const { client, sent } = fixture(); t.after(() => client.close()); await client.initialize(); const before = sent.length;
  await assert.rejects(client.contextFiles('bad-id'), /Invalid thread/);
  for (const body of [{ path: '', included: true }, { path: '/x', included: 'true' }, { path: '/x', included: true, extra: true }]) await assert.rejects(client.setContextFile(ID, body));
  assert.equal(sent.length, before);
});
test('context files HTTP routes require authentication and preserve the engine response', async t => {
  const { client, files } = fixture(); await client.initialize();
  const app = await startDesktopServer({ client, staticDir: fileURLToPath(new URL('../out', import.meta.url)), loveSpot: { directory: '/tmp/ctxdesk-test-love' } }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const endpoint = origin + '/api/threads/' + ID + '/context-files';
  assert.equal((await fetch(endpoint)).status, 401);
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const headers = { 'Content-Type': 'application/json', Origin: origin, Cookie: auth.headers.get('set-cookie').split(';')[0] };
  assert.deepEqual(await (await fetch(endpoint, { headers })).json(), { files });
  const saved = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ path: files[0].path, included: false }) });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).files[0].included, false);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ path: '/x', included: 'yes' }) })).status, 400);
});

test('an older installed engine gives a clear update instruction for both context file methods', async t => {
  const { client } = fixture({ unsupported: true }); t.after(() => client.close()); await client.initialize();
  const update = error => error.status === 503 && /Update and restart Elpis.*context files/.test(error.message);
  await assert.rejects(client.contextFiles(ID), update);
  await assert.rejects(client.setContextFile(ID, { path: '/tmp/project/ES.md', included: true }), update);
});
