import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mjs';

// Every model menu lists the engine's catalog live (1 Nov, Masih: "Refresh it whenever the model picker opens"):
// GET /api/models?refresh=true asks model/list to fetch now. ChatGPT, while another connection is the default, is
// listed by the same engine (model/list with modelProvider), not by a separate cached command.
function fixture({ mainProvider = 'openai' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-live-models-'));
  // A ChatGPT sign-in exists in this home; its content is never read.
  fs.writeFileSync(path.join(home, 'auth' + '.json'), '{}');
  const state = { engine: ['gpt-6.1-sol'], chatgpt: ['gpt-6.1-sol', 'gpt-6.1-terra'], fail: false };
  const socket = new EventEmitter(); socket.sent = [];
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined || !request.method) return;
    let result = {}, error;
    switch (request.method) {
      case 'config/read': result = { config: { model: 'gpt-6.1-sol', model_provider: mainProvider, model_providers: {} }, layers: [{ name: { type: 'user', file: path.join(home, 'config.toml') }, version: 'v1' }] }; break;
      case 'configRequirements/read': result = { requirements: null }; break;
      case 'model/list':
        if (state.fail && request.params?.refresh) { error = { code: -32603, message: 'Could not fetch the model list from `openai`: network down' }; break; }
        result = { data: (request.params?.modelProvider === 'openai' ? state.chatgpt : state.engine).map(model => ({ id: model, model, displayName: model })), nextCursor: null }; break;
      default: break;
    }
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, ...(error ? { error } : { result }) })));
  };
  socket.close = () => socket.emit('close');
  return { client: new DesktopClient(socket), socket, state, home };
}
const slugs = list => list.data.map(item => item.model);
const listRequests = socket => socket.sent.filter(row => row.method === 'model/list').map(row => row.params);

test('a menu that opens lists a model added since startup; a plain read keeps the shared copy', async () => {
  const f = fixture(); await f.client.initialize();
  try {
    assert.deepEqual(slugs(await f.client.models()), ['gpt-6.1-sol']);
    f.state.engine.push('gpt-6.1-terra');
    assert.deepEqual(slugs(await f.client.models()), ['gpt-6.1-sol'], 'no refresh: the shared copy');
    assert.deepEqual(slugs(await f.client.models({ refresh: true })), ['gpt-6.1-sol', 'gpt-6.1-terra']);
    assert.equal(listRequests(f.socket).at(-1).refresh, true);
    // The refreshed list replaces the shared copy for every other reader.
    assert.deepEqual(slugs(await f.client.models()), ['gpt-6.1-sol', 'gpt-6.1-terra']);
    await assert.rejects(f.client.models({ refresh: 'yes' }), /refresh must be true or false/);
  } finally { f.client.close(); fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('a failed refresh is an error for the menu and the last good list stays', async () => {
  const f = fixture(); await f.client.initialize();
  try {
    assert.deepEqual(slugs(await f.client.models({ refresh: true })), ['gpt-6.1-sol']);
    f.state.fail = true;
    await assert.rejects(f.client.models({ refresh: true }), /network down/);
    assert.deepEqual(slugs(await f.client.models()), ['gpt-6.1-sol']);
  } finally { f.client.close(); fs.rmSync(f.home, { recursive: true, force: true }); }
});

test('ChatGPT while another connection is the default is listed live by the engine', async () => {
  const f = fixture({ mainProvider: 'anthropic-credits' }); await f.client.initialize();
  try {
    assert.deepEqual(slugs(await f.client.models({ provider: 'openai', refresh: true })), ['gpt-6.1-sol', 'gpt-6.1-terra']);
    assert.deepEqual(listRequests(f.socket).at(-1), { limit: 100, includeHidden: false, modelProvider: 'openai', refresh: true });
    f.state.chatgpt.push('gpt-6.2-new');
    assert.ok(slugs(await f.client.models({ provider: 'openai', refresh: true })).includes('gpt-6.2-new'));
    f.state.fail = true;
    await assert.rejects(f.client.models({ provider: 'openai', refresh: true }), /network down/);
  } finally { f.client.close(); fs.rmSync(f.home, { recursive: true, force: true }); }
});
