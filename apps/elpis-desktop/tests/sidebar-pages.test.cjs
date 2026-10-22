// OBSRM: exported-renderer regression. Real bridge acceptance is sidebar-pages-app.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

const retired = 'observability'; // Legacy saved data only; never a supported destination.
const pages = ['experimentLab', 'canvas', 'loveSpot', 'matilda', 'customize'];
const names = { experimentLab: 'Lab', canvas: 'Workflows', loveSpot: 'Love Spot', matilda: 'Matilda', customize: 'Customize' };
const nav = page => page.locator('aside.sidebar nav[aria-label="Workspace"]');
const labels = page => nav(page).getByRole('button').allTextContents();

for (const theme of ['light', 'dark']) test(`OBSRM: default sidebar and command menu contain only supported pages (${theme})`, async () => {
  const f = await fixture({ width: 1280, height: 800, colorScheme: theme });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    if (process.env.ELPIS_PARITY_SHOTS) {
      await fs.mkdir(process.env.ELPIS_PARITY_SHOTS, { recursive: true });
      await f.page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `sidebar-${theme}.png`) });
    }
    assert.deepEqual(await labels(f.page), ['New chat', ...pages.map(id => names[id])]);
    await f.page.keyboard.press('Control+k');
    await f.page.getByRole('combobox', { name: 'Search or start a chat' }).fill(retired);
    assert.equal(await f.page.getByRole('option', { name: /^Observability$/i }).count(), 0);
    await f.page.keyboard.press('Escape');
    await f.open('chat-a');
    assert.equal(await f.composer.isVisible(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const position of [0, 2, 4]) test(`OBSRM: legacy page at position ${position} and saved view load safely without losing order`, async () => {
  const order = ['customize', 'loveSpot', 'canvas', 'experimentLab'];
  const saved = [...order]; saved.splice(position, 0, retired);
  const f = await fixture({ storage: { 'elpis-preferences-v1': JSON.stringify({ navOrder: saved.join(','), view: retired }) } });
  try {
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await f.page.reload();
      await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
      assert.deepEqual(await labels(f.page), ['New chat', ...order.map(id => names[id]), 'Matilda'], 'a page the saved order does not know comes last');
      assert.equal(await f.composer.isVisible(), true, 'a stale saved view must not leave a blank app');
      await f.open('chat-a');
      assert.equal(await f.composer.isVisible(), true);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
