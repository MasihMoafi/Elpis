// The Customize page's data (bridge/customize.mjs): skills and plugins as the engine reports them, shaped for the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginCatalogSnapshot, pluginsSnapshot, skillsSnapshot } from './customize.mjs';

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
