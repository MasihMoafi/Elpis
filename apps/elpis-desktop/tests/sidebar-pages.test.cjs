// Observability is a sidebar page again (5 Nov, Masih: "I don't see an observability in Elpis gui ... it already was there
// with a logo I had approved"); it was retired on 21 Oct (A132). Exported-renderer checks of the page list and saved order.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

const pages = ['experimentLab', 'canvas', 'loveSpot', 'observability', 'customize'];
const names = { experimentLab: 'Lab', canvas: 'Workflows', loveSpot: 'Love Spot', observability: 'Observability', customize: 'Customize' };
const nav = page => page.locator('aside.sidebar nav[aria-label="Workspace"]');
const labels = page => nav(page).getByRole('button').allTextContents();

for (const theme of ['light']) test(`the default sidebar and the command menu list every page, Observability included (${theme})`, async () => {
  const f = await fixture({ width: 1280, height: 800, colorScheme: theme });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    if (process.env.ELPIS_PARITY_SHOTS) {
      await fs.mkdir(process.env.ELPIS_PARITY_SHOTS, { recursive: true });
      await f.page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `sidebar-${theme}.png`) });
    }
    assert.deepEqual(await labels(f.page), ['New chat', ...pages.map(id => names[id])]);
    await f.page.keyboard.press('Control+k');
    await f.page.getByRole('combobox', { name: 'Search or start a chat' }).fill('observability');
    assert.equal(await f.page.getByRole('option', { name: /^Observability$/i }).count(), 1);
    await f.page.keyboard.press('Escape');
    await f.open('chat-a');
    assert.equal(await f.composer.isVisible(), true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a saved order with Observability keeps its place, and a saved Observability view still lets a chat open', async () => {
  const order = ['customize', 'loveSpot', 'observability', 'canvas', 'experimentLab'];
  const f = await fixture({ storage: { 'elpis-preferences-v1': JSON.stringify({ navOrder: order.join(','), view: 'observability' }) } });
  try {
    for (let reload = 0; reload < 2; reload++) {
      if (reload) await f.page.reload();
      await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
      assert.deepEqual(await labels(f.page), ['New chat', ...order.map(id => names[id])]);
      await f.open('chat-a');
      assert.equal(await f.composer.isVisible(), true);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
