const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const { openSettings } = require('./controls.cts');

const settings = (writable: boolean) => ({ version: 'v1', main: { model: 'sol', provider: 'openai' }, background: { model: null, provider: null },
  providers: [{ id: 'openai', displayName: 'OpenAI' }], smartPrune: { enabled: false, explicitOverride: {} },
  memory: { enabled: false, generate: null, use: null, skipExternalContext: null, extractionModel: null, consolidationModel: null },
  write: { available: writable, reason: writable ? '' : 'Read only' } });

test('reset refreshes the file count and ignores an older count response', async () => {
  let requests = 0, reset = false;
  const { promise: firstCount, resolve: releaseFirst } = Promise.withResolvers<{ count: number }>();
  const f = await fixture({ routes: {
    '/api/settings': () => settings(true),
    '/api/memories/count': () => ++requests === 1 ? firstCount : { count: reset ? 0 : 3 },
    '/api/memories/reset': () => { reset = true; return { reset: true }; },
  } });
  try {
    await openSettings(f.page, 'Personalization');
    const count = f.page.locator('[data-slot="settings-row"]').filter({ hasText: 'Saved memory files' }); await count.getByText('Loading…', { exact: true }).waitFor();
    await f.page.getByRole('button', { name: 'Delete', exact: true }).click();
    await f.page.getByRole('alertdialog').getByRole('button', { name: 'Delete memories', exact: true }).click();
    await count.getByText('0', { exact: true }).waitFor();
    releaseFirst({ count: 3 }); await f.page.waitForTimeout(200);
    assert.equal(await count.getByRole('status').innerText(), '0');
    assert.equal(f.posts.filter((post: { path: string }) => post.path === '/api/memories/reset').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { releaseFirst({ count: 3 }); await f.close(); }
});

test('an unavailable file count is labeled in read-only settings', async () => {
  let unavailable = false;
  const f = await fixture({ routes: {
    '/api/settings': () => settings(false),
    '/api/memories/count': () => unavailable ? ({ __http: 503, error: 'Saved memory file count is unavailable.' }) : ({ count: 2 }),
  } });
  try {
    await openSettings(f.page, 'Personalization');
    const count = f.page.locator('[data-slot="settings-row"]').filter({ hasText: 'Saved memory files' }); await count.getByText('2', { exact: true }).waitFor();
    await f.page.getByRole('tab', { name: 'General', exact: true }).click(); unavailable = true;
    await f.page.getByRole('tab', { name: 'Personalization', exact: true }).click();
    await count.getByText('Unavailable', { exact: true }).waitFor();
    assert.equal(await count.getByText('0', { exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
