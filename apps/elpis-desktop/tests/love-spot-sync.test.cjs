const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

const output = path.join(os.homedir(), '.cache/elpis-tests/night-lovespot-sync');

// Clipboard Copy observes the actual editor through a user action, including
// the absence of a deleted element. Disk alone cannot prove renderer convergence.
async function copied(page) {
  await page.locator('.excalidraw').click({ position: { x: 900, y: 650 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+a');
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await page.keyboard.press('ControlOrMeta+c');
  const text = await page.evaluate(() => navigator.clipboard.readText());
  try { return JSON.parse(text).elements.filter(e => !e.isDeleted); } catch { return []; }
}

for (const colorScheme of ['light', 'dark']) test(`two windows keep a real delete after a delayed equal-version live edit · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  let release, held;
  try {
    await fs.mkdir(output, { recursive: true });
    await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await f.open(f.page); await f.draw(f.page);
    const original = (await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'initial shape did not save')).elements[0];
    const stale = await f.newPage();
    // Freeze this client's event stream before it opens the board, so its real
    // keyboard edit and the other client's Delete share the same base version.
    await stale.route('**/api/love-spot/events?*', route => route.fulfill({ contentType: 'text/event-stream', body: ': paused\n\n' }));
    await f.open(stale);
    await f.waitFor(async () => (await copied(stale))[0]?.id === original.id, 'second canvas did not load the original shape');
    const gate = new Promise(resolve => { release = resolve; });
    await stale.route('**/api/love-spot', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const drawing = route.request().postDataJSON();
      const live = drawing.elements.find(e => e.id === original.id && !e.isDeleted);
      if (!held && live) {
        held = drawing;
        await gate;
        // Nonces are random. Force the adversarial tie order without changing
        // the real keyboard-generated version or deletion flag.
        live.versionNonce = 0;
        return route.continue({ postData: JSON.stringify(drawing) });
      }
      return route.continue();
    });
    await stale.keyboard.press('ArrowRight');
    await f.waitFor(() => held, 'stale keyboard edit was not queued');
    await f.page.bringToFront();
    assert.equal((await copied(f.page))[0]?.id, original.id);
    await f.page.route('**/api/love-spot', route => {
      if (route.request().method() !== 'POST') return route.continue();
      const drawing = route.request().postDataJSON();
      const deleted = drawing.elements.find(e => e.id === original.id && e.isDeleted);
      if (deleted) deleted.versionNonce = 2147483647;
      return route.continue({ postData: JSON.stringify(drawing) });
    });
    await f.page.keyboard.press('Delete');
    const deleted = (await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'real Delete did not save')).elements.find(e => e.id === original.id);
    assert.equal(held.elements.find(e => e.id === original.id).version, deleted.version, 'the eval must exercise an equal-version conflict');
    const saved = stale.waitForResponse(response => new URL(response.url()).pathname === '/api/love-spot' && response.request().method() === 'POST');
    release(); await saved;
    await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'delayed live save revived the delete');
    await stale.bringToFront();
    await f.waitFor(async () => (await copied(stale)).length === 0, 'the stale renderer ignored the winning tombstone');
    // Resume real synchronization and check that subsequent actions cannot
    // republish the stale shape from either window.
    await stale.unroute('**/api/love-spot/events?*');
    await stale.reload(); await stale.locator('.startup-splash').waitFor({ state: 'detached' }); await f.open(stale);
    await f.draw(stale, 140);
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 1 && s.elements.find(e => e.id === original.id)?.isDeleted, 'next edit revived the deleted shape');
    await f.page.bringToFront();
    await f.waitFor(async () => (await copied(f.page)).length === 1, 'surviving addition did not reach both windows');
    await f.page.keyboard.press('Escape');
    await f.page.screenshot({ path: path.join(output, `delete-${colorScheme}.png`) });
    await fs.writeFile(path.join(output, `conflict-${colorScheme}.json`), JSON.stringify({ original, deleted, delayed: held.elements, final: (await f.scene()).elements }, null, 2));
    assert.deepEqual(f.errors, []);
  } finally { release?.(); await f.close(); }
});

test('remote deletion is not a local undo step; deliberate delete undo and redo synchronize', async () => {
  const f = await loveSpotFixture();
  try {
    await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await f.open(f.page); await f.draw(f.page);
    const original = (await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'initial shape did not save')).elements[0];
    const other = await f.newPage(); await f.open(other);
    await f.waitFor(async () => (await copied(other))[0]?.id === original.id, 'second window did not load');
    await other.keyboard.press('Delete');
    await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'delete did not save');
    await f.page.bringToFront();
    await f.waitFor(async () => (await copied(f.page)).length === 0, 'remote delete did not arrive');
    await f.page.keyboard.press('ControlOrMeta+z');
    await f.page.waitForTimeout(500);
    assert.equal((await f.scene()).elements.find(e => e.id === original.id).isDeleted, true, 'undo in the receiving window must not undo a remote deletion');
    assert.equal((await copied(f.page)).length, 0);
    await other.bringToFront();
    await other.keyboard.press('ControlOrMeta+z');
    await f.waitFor(s => !s.elements.find(e => e.id === original.id)?.isDeleted, 'deliberate undo did not restore');
    await f.page.bringToFront();
    await f.waitFor(async () => (await copied(f.page)).some(e => e.id === original.id), 'undo did not reach the other canvas');
    await other.bringToFront(); await other.keyboard.press('ControlOrMeta+Shift+z');
    await f.waitFor(s => s.elements.find(e => e.id === original.id)?.isDeleted, 'redo did not delete');
    await f.page.bringToFront();
    await f.waitFor(async () => (await copied(f.page)).length === 0, 'redo did not reach the other canvas');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('placing a screenshot remains a deliberate local undo and redo action', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(f.screenshots, 'undo.png'), png);
    await f.page.getByRole('button', { name: 'Add undo.png to drawing', exact: true }).click();
    const scene = await f.waitFor(s => s.elements.some(e => e.type === 'image' && !e.isDeleted), 'placement did not save');
    const id = scene.elements.find(e => e.type === 'image').id;
    await f.page.locator('.excalidraw').click({ position: { x: 900, y: 650 } });
    await f.page.keyboard.press('ControlOrMeta+z');
    await f.waitFor(s => s.elements.find(e => e.id === id)?.isDeleted, 'undo could not remove the placed screenshot');
    await f.page.keyboard.press('ControlOrMeta+Shift+z');
    await f.waitFor(s => s.elements.some(e => e.id === id && !e.isDeleted) && Object.keys(s.files).length === 1, 'redo could not restore screenshot pixels');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
