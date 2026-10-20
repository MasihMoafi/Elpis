// Masih, 20 Oct screenshot: with nothing open, the side panel's four buttons ran off both edges of a narrow panel.
// At the narrowest width the real resize control allows, every button must sit inside the panel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('empty side panel keeps all four buttons inside its minimum width', async () => {
  const f = await fixture({ desktop: true, width: 1280, height: 800 });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.open('chat-a');
    await f.page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    const panel = f.page.getByRole('region', { name: 'Side panel', exact: true });
    const initial = await panel.boundingBox();
    assert.ok(initial && initial.width > 380, 'panel starts wider than its minimum');
    const resize = f.page.locator('.side-resize');
    await resize.focus();
    const steps = Math.ceil((initial.width - 380) / 32) + 1;
    for (let step = 0; step < steps; step++) await resize.press('ArrowRight');

    const box = await panel.boundingBox();
    assert.ok(box && Math.abs(box.width - 380) <= 1, 'real resize control reaches the 380px minimum');
    const buttons = panel.locator('.side-empty button');
    assert.equal(await buttons.count(), 4, 'empty panel offers all four actions');
    const overflowing = [];
    for (const button of await buttons.all()) {
      const name = (await button.innerText()).trim();
      assert.ok(await button.isVisible(), `${name} is visible`);
      const bounds = await button.boundingBox();
      assert.ok(bounds && bounds.width > 0 && bounds.height > 0, `${name} has visible bounds`);
      if (bounds.x < box.x - 1 || bounds.y < box.y - 1
        || bounds.x + bounds.width > box.x + box.width + 1
        || bounds.y + bounds.height > box.y + box.height + 1) {
        overflowing.push({ name, bounds });
      }
    }
    assert.deepEqual(f.errors, []);
    assert.deepEqual(overflowing, [], `every button stays inside the panel (±1px): ${JSON.stringify(box)}`);
  } finally { await f.close(); }
});
