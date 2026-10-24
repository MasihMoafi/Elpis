// The Customize page's data (bridge/customize.mjs): skills and plugins as the engine reports them, shaped for the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pluginCatalogSnapshot, pluginsSnapshot, skillsSnapshot } from './customize.mjs';
import { CustomizePage } from './customize-page.mjs';

test('skills: each once, named by their interface when they have one, by name, with scope, state and load errors', () => {
  const skill = (name, extra = {}) => ({ name, description: `${name} long`, path: `/s/${name}/SKILL.md`, scope: 'user', enabled: true, ...extra });
  const snapshot = skillsSnapshot({ data: [
    { cwd: '/p', skills: [skill('web-dev'), skill('pdf', { interface: { displayName: 'PDF', shortDescription: 'Read PDFs' }, scope: 'system', enabled: false, pluginId: 'docs@x' })], errors: [{ path: '/s/bad/SKILL.md', message: 'missing name' }] },
    { cwd: '/q', skills: [skill('web-dev'), { name: 'broken' }], errors: [] },
  ] });
  assert.deepEqual(snapshot.data.map(item => [item.name, item.scope, item.enabled, item.description, item.plugin]), [['PDF', 'system', false, 'Read PDFs', 'docs@x'], ['web-dev', 'user', true, 'web-dev long', null]]);
  assert.deepEqual(snapshot.errors, [{ path: '/s/bad/SKILL.md', message: 'missing name' }]);
  assert.deepEqual(skillsSnapshot(null), { data: [], errors: [] });
});

test('catalog keeps marketplace identities, empty sources, search cursors, installed state and policy reasons', () => {
  const plugin = { id: 'docs@market', name: 'docs', installed: true, enabled: false, installPolicy: 'AVAILABLE', availability: 'AVAILABLE', interface: { displayName: 'Docs', shortDescription: 'Write docs' } };
  const response = { marketplaces: [{ name: 'market', path: '/market/.claude-plugin/marketplace.json', interface: { displayName: 'My marketplace' }, plugins: [plugin] }, { name: 'empty', path: '/empty/.agents/plugins/marketplace.json', plugins: [] }], marketplaceLoadErrors: [{ marketplacePath: '/broken', message: 'Malformed manifest' }] };
  const catalog = pluginCatalogSnapshot(response);
  assert.equal(catalog.marketplaces.length, 2);
  assert.deepEqual(catalog.plugins.map(item => [item.id, item.name, item.marketplaceName, item.marketplacePath, item.installed, item.enabled, item.installable]), [['docs@market', 'Docs', 'market', '/market/.claude-plugin/marketplace.json', true, false, true]]);
  assert.match(catalog.errors[0], /broken: Malformed manifest/);
  const search = pluginCatalogSnapshot(response, { data: [{ plugin: { ...plugin, installed: false, installPolicy: 'NOT_AVAILABLE' }, marketplaceName: 'market', marketplacePath: null }], nextCursor: 'page-2' });
  assert.equal(search.nextCursor, 'page-2');
  assert.equal(search.plugins[0].installable, false);
  assert.match(search.plugins[0].reason, /Installation unavailable/);
  assert.equal(search.plugins[0].marketplace, 'My marketplace');
  assert.equal(pluginCatalogSnapshot(response, { data: [{ plugin, marketplaceName: 'not-added' }] }).plugins.length, 0);
  assert.match(pluginsSnapshot(response).error, /Malformed manifest/);
});

test('plugins: only the installed ones, by name, with their marketplace and state', () => {
  const snapshot = pluginsSnapshot({ marketplaces: [{ name: 'local', interface: { displayName: 'My plugins' }, plugins: [
    { id: 'b@local', name: 'b', installed: true, enabled: false },
    { id: 'a@local', name: 'a', installed: true, enabled: true, interface: { displayName: 'Alpha', shortDescription: 'Does A' } },
    { id: 'c@local', name: 'c', installed: false, enabled: false }] }] });
  assert.deepEqual(snapshot.data, [
    { id: 'a@local', name: 'Alpha', description: 'Does A', marketplace: 'My plugins', enabled: true },
    { id: 'b@local', name: 'b', description: '', marketplace: 'My plugins', enabled: false }]);
});

function catalogPage(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'customize-catalog-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plugin = { id: 'hyperframes@openai-curated', name: 'hyperframes', installed: false, installPolicy: 'AVAILABLE', keywords: ['GSAP'],
    interface: { displayName: 'HyperFrames by HeyGen', shortDescription: 'Write HTML, render video', longDescription: 'Add captions' } };
  const market = { name: 'openai-curated', path: path.join(home, '.tmp/plugins/.agents/plugins/marketplace.json'), plugins: [plugin, { id: 'notes@openai-curated', name: 'notes', installPolicy: 'AVAILABLE' }] };
  const f = { plugin, market, calls: [], catalog: { marketplaces: [market] }, search: { data: [], nextCursor: null }, listError: null,
    searchError: new Error('search remote plugin catalog: remote plugin catalog request to https://chatgpt.com/backend-api/ps/plugins/search failed with status 400 Bad Request: {"detail":"WORKSPACE scope requires an active workspace"} (ELPIS_RUNTIME_ERROR)') };
  f.page = new CustomizePage({ appHome: home, home: () => home,
    mcp: async () => ({ servers: [], version: 'v1', write: { available: true } }), githubConnector: { snapshot: async () => ({ name: 'GitHub' }) },
    rpc: async (method, params) => {
      f.calls.push({ method, params });
      if (method === 'plugin/list') { if (f.listError) throw f.listError; return f.catalog; }
      if (method === 'plugin/search') { if (f.searchError) throw f.searchError; return f.search; }
      if (method === 'plugin/install') { plugin.installed = true; return {}; }
      if (method === 'plugin/installed') return f.catalog;
      if (method === 'skills/list') return { data: [] };
      throw new Error(`Unexpected method ${method}`);
    } });
  return f;
}

test('remote catalog refusal falls back to case-insensitive local names, display names, descriptions and keywords; HyperFrames installs from its marketplace', async t => {
  const f = catalogPage(t);
  for (const search of [' HYPERFRAMES ', 'hEyGeN', 'hTmL', 'cApTiOnS', 'gSaP']) {
    const result = await f.page.pluginCatalog({ cwd: '/project', search });
    assert.deepEqual(result.plugins.map(plugin => plugin.id), [f.plugin.id], search);
    assert.deepEqual(result.errors, []);
    assert.equal(result.nextCursor, null);
  }
  const installed = await f.page.changePlugin({ action: 'install', id: f.plugin.id, cwd: '/project' });
  assert.deepEqual(f.calls.filter(call => call.method === 'plugin/install').map(call => call.params), [{ pluginName: 'hyperframes', marketplacePath: f.market.path }]);
  assert.deepEqual(installed.plugins.data.map(plugin => plugin.id), [f.plugin.id]);
});

test('an unmatched local search stays empty without an error when the remote catalog refuses', async t => {
  const f = catalogPage(t), result = await f.page.pluginCatalog({ search: 'no-such-plugin' });
  assert.deepEqual(result.plugins, []);
  assert.deepEqual(result.errors, []);
  assert.equal(result.nextCursor, null);
});

test('successful remote search merges with local matches once, preserving local installation paths and remote pagination', async t => {
  const f = catalogPage(t);
  f.searchError = null;
  const remote = { id: 'video@openai-curated', name: 'video', installPolicy: 'AVAILABLE' };
  f.search = { data: [f.plugin, remote, remote].map(plugin => ({ plugin, marketplaceName: f.market.name, marketplacePath: null })), nextCursor: 'page-2' };
  const result = await f.page.pluginCatalog({ cwd: '/project', search: 'hyperframes', cursor: 'page-1' });
  assert.deepEqual(result.plugins.map(plugin => plugin.id), [f.plugin.id, remote.id]);
  assert.equal(result.plugins[0].marketplacePath, f.market.path);
  assert.equal(result.nextCursor, 'page-2');
  assert.deepEqual(f.calls.find(call => call.method === 'plugin/search').params, { cwds: ['/project'], searchTerm: 'hyperframes', cursor: 'page-1', limit: 50 });
});

test('genuine catalog, marketplace loading and engine search errors remain visible', async t => {
  const f = catalogPage(t);
  f.listError = new Error('plugin/list failed: config is unreadable');
  await assert.rejects(f.page.pluginCatalog({ search: 'hyperframes' }), f.listError);
  assert.equal(f.calls.some(call => call.method === 'plugin/search'), false);
  f.listError = null; f.searchError = new Error('plugin/search transport is unavailable');
  await assert.rejects(f.page.pluginCatalog({ search: 'hyperframes' }), f.searchError);
  f.searchError = null;
  f.catalog.marketplaceLoadErrors = [{ marketplacePath: '/broken', message: 'Malformed manifest' }];
  assert.deepEqual((await f.page.pluginCatalog({ search: 'no-such-plugin' })).errors, ['/broken: Malformed manifest']);
});

test('a plugin in a catalog on this computer is listed once, without its remote copy; other remote plugins stay', async t => {
  const f = catalogPage(t);
  f.catalog.marketplaces.push({ name: 'openai-curated-remote', path: null, plugins: [
    { id: 'hyperframes@openai-curated-remote', name: 'hyperframes', installed: false, installPolicy: 'AVAILABLE' },
    { id: 'video@openai-curated-remote', name: 'video', installed: false, installPolicy: 'AVAILABLE' }] });
  const ids = (await f.page.pluginCatalog({})).plugins.map(plugin => plugin.id);
  assert.ok(ids.includes('hyperframes@openai-curated') && ids.includes('video@openai-curated-remote'), ids.join());
  assert.ok(!ids.includes('hyperframes@openai-curated-remote'), ids.join());
});

test('two plugins sharing a display name are told apart by their own names; a unique name is left alone', async t => {
  const f = catalogPage(t);
  f.market.plugins.push({ id: 'core-skills@openai-curated', name: 'core-skills', installPolicy: 'AVAILABLE', interface: { displayName: 'HyperFrames by HeyGen' } });
  const names = (await f.page.pluginCatalog({})).plugins.map(plugin => plugin.name);
  assert.deepEqual(names.filter(name => name.startsWith('HyperFrames')).sort(), ['HyperFrames by HeyGen (core-skills)', 'HyperFrames by HeyGen (hyperframes)']);
  assert.ok(names.includes('notes'), names.join());
});
