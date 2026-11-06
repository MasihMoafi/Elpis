// Observability is a sidebar page again (5 Nov, Masih: "I don't see an observability in Elpis gui ... it already was there
// with a logo I had approved"); it was retired on 21 Oct (A132). Exported-renderer checks of the page list and saved order.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

const names = { experimentLab: 'Lab', canvas: 'Workflows', loveSpot: 'Love Spot', observability: 'Observability', customize: 'Customize' };
const nav = page => page.locator('aside.sidebar nav[aria-label="Workspace"]');
const labels = page => nav(page).getByRole('button').allTextContents();

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
