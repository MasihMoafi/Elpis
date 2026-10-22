import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopClient } from './client.mjs';

/** A computer with the Claude app's catalog and the ChatGPT app's, and an engine that lists the marketplaces it was given. */
function setup(t, { chatgpt = true } = {}) {
  const root = path.join(os.tmpdir(), `app-catalogs-${randomUUID()}`), home = path.join(root, 'home'), elpis = path.join(root, 'elpis');
  const make = (folder, manifest) => { fs.mkdirSync(path.join(home, folder, path.dirname(manifest)), { recursive: true }); fs.writeFileSync(path.join(home, folder, manifest), '{}'); };
  make('.claude/plugins/marketplaces/claude-plugins-official', '.claude-plugin/marketplace.json');
  if (chatgpt) make('.codex/.tmp/bundled-marketplaces/openai-bundled', '.agents/plugins/marketplace.json');
  const previous = process.env.ELPIS_HOME; process.env.ELPIS_HOME = elpis; t.after(() => { if (previous === undefined) delete process.env.ELPIS_HOME; else process.env.ELPIS_HOME = previous; });
  const socket = new EventEmitter(), listed = [], saved = []; socket.sent = []; socket.close = () => {};
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined) return;
    const result = request.method === 'plugin/list' ? { marketplaces: listed.map(name => ({ name, path: `/${name}/marketplace.json`, plugins: [] })) } : {};
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id: request.id, result })));
  };
  const client = new DesktopClient(socket, { appHome: home, archiveDirectory: path.join(root, 'archives'), rewindHome: path.join(root, 'rewind'), spawnLinksFile: path.join(root, 'links.json'),
    githubConnector: { instructions: async () => null }, workflowOptions: { stateDir: path.join(root, 'workflows') } });
  Object.assign(client, { settings: async () => ({ version: 'v1' }), saveSettings: async input => { saved.push(input); } });
  t.after(() => client.close());
  return { client, socket, listed, saved, home, elpis };
}
const sent = (socket, method) => socket.sent.filter(request => request.method === method).map(request => request.params);

test('the catalogs of the Claude and ChatGPT apps on this computer are offered until they are added', async t => {
  const f = setup(t);
  assert.deepEqual((await f.client.pluginCatalog()).appCatalogs, [{ app: 'claude', label: 'Claude', added: false }, { app: 'chatgpt', label: 'ChatGPT', added: false }]);
  f.listed.push('claude-plugins-official');
  assert.deepEqual((await f.client.pluginCatalog()).appCatalogs.map(item => [item.app, item.added]), [['claude', true], ['chatgpt', false]]);
  const without = setup(t, { chatgpt: false });
  assert.deepEqual((await without.client.pluginCatalog()).appCatalogs.map(item => item.app), ['claude'], 'an app that is not installed offers nothing');
});

test('adding the Claude catalog turns plugins on and reads the app\'s folder in place', async t => {
  const f = setup(t);
  await f.client.changeMarketplace({ action: 'add-app', app: 'claude' });
  assert.deepEqual(f.saved, [{ version: 'v1', features: { plugins: true } }]);
  assert.deepEqual(sent(f.socket, 'marketplace/add'), [{ source: path.join(f.home, '.claude/plugins/marketplaces/claude-plugins-official') }]);
  await assert.rejects(f.client.changeMarketplace({ action: 'add-app', app: 'gemini' }), /no plugin catalog/);
});

test('adding the ChatGPT catalog links the app\'s folder where the engine keeps its bundled catalog and names it in the config', async t => {
  const f = setup(t), source = path.join(f.home, '.codex/.tmp/bundled-marketplaces/openai-bundled');
  await f.client.changeMarketplace({ action: 'add-app', app: 'chatgpt' });
  const link = path.join(f.elpis, '.tmp/bundled-marketplaces/openai-bundled');
  assert.equal(fs.readlinkSync(link), source);
  assert.deepEqual(sent(f.socket, 'config/batchWrite'), [{ expectedVersion: 'v1', reloadUserConfig: true,
    edits: [{ keyPath: 'marketplaces."openai-bundled"', value: { source_type: 'local', source: link }, mergeStrategy: 'replace' }] }]);
  await f.client.changeMarketplace({ action: 'add-app', app: 'chatgpt' });
  assert.equal(fs.readlinkSync(link), source, 'adding it again keeps the link');
  assert.deepEqual(sent(f.socket, 'marketplace/add'), [], 'the reserved name never goes through marketplace/add');
});
