// lib/settings-store.ts: a saved default posts only its own options with the version it read and adopts the bridge's
// answer; reopening re-reads what another client saved.
import test from 'node:test';
import assert from 'node:assert/strict';
import './alias.mjs';
const { reloadSettings, saveOptions } = await import('../lib/settings-store.ts');

const snapshot = (version, reasoningEffort, model = null) => ({ version, main: { model }, background: {}, smartPrune: {}, memory: {}, options: { reasoningEffort }, write: { available: true, reason: '' } });
function bridge(t, answer) {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const posts = []; globalThis.fetch = async (url, init) => { const body = init?.body ? JSON.parse(init.body) : undefined; if (body) posts.push({ url: String(url), body }); return { ok: true, status: 200, json: async () => answer(body) }; };
  return posts;
}

test('saving the default reasoning effort posts only that option with the version read, and adopts the saved snapshot', async t => {
  const posts = bridge(t, body => body ? snapshot('v2', body.options.reasoningEffort) : snapshot('v1', 'medium'));
  const read = await reloadSettings();
  const saved = await saveOptions(read, { reasoningEffort: 'high' });
  assert.deepEqual(posts.map(post => post.body), [{ version: 'v1', options: { reasoningEffort: 'high' } }]);
  assert.match(posts[0].url, /\/settings$/);
  assert.equal(saved.version, 'v2'); assert.equal(saved.options.reasoningEffort, 'high');
});

test('reopening re-reads a default another client saved, without writing anything', async t => {
  let current = snapshot('v1', null);
  const posts = bridge(t, () => current);
  assert.equal((await reloadSettings()).main.model, null, 'an unset default stays unset');
  current = snapshot('v2', null, 'sol');
  assert.equal((await reloadSettings()).main.model, 'sol');
  assert.deepEqual(posts, []);
});

test('a save based on a stale version reports the bridge\'s conflict instead of overwriting', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, init) => init?.body
    ? { ok: false, status: 409, json: async () => ({ error: 'Settings changed elsewhere. Reload to see the current values.' }) }
    : { ok: true, status: 200, json: async () => snapshot('v1', 'medium') };
  const read = await reloadSettings();
  await assert.rejects(saveOptions(read, { reasoningEffort: 'high' }), /Settings changed elsewhere/);
});
