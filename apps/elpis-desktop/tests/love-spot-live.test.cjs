const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');

test('Love Spot real bridge: mouse strokes sync, stale windows retain both, delete syncs, typing survives navigation', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    assert.equal(f.requests.some(url => url.includes('/love-spot-assets/')), false);
    await f.open(page);
    await f.draw(page);
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 1, 'first mouse stroke was not saved');
    const other = await f.newPage(); await f.open(other);
    await f.draw(other, 140);
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 2, 'second window lost a stroke');
    // Deleting from the first page must also delete the other window's stroke: it has to have arrived.
    const at = Date.now();
    await page.bringToFront(); await page.waitForTimeout(200);
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Delete');
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 0, 'remote stroke did not reach the first page', 1000);
    assert.ok(Date.now() - at < 1000);
    await page.waitForTimeout(1200);
    assert.deepEqual(await page.locator('.love-spot [role="alert"]').allTextContents(), [], 'clearing the drawing must also export an empty picture');
    assert.equal((await fs.readFile(path.join(f.directory, 'view.png'))).subarray(1, 4).toString(), 'PNG');
    const bounds = await page.locator('.excalidraw').boundingBox();
    await page.keyboard.press('t'); await page.mouse.click(bounds.x + 500, bounds.y + 260);
    await page.keyboard.type('Our love spot'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.text === 'Our love spot' && !e.isDeleted), 'typing was lost when leaving the page');
    await f.open(page);
    await page.keyboard.press('ControlOrMeta+a');
    assert.equal((await f.scene()).elements.filter(e => e.type === 'text' && !e.isDeleted).length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Love Spot real bridge: inbox and screenshot appear, PNG is exported; light and dark captures', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const f = await loveSpotFixture({ colorScheme });
    try {
      await fs.writeFile(path.join(f.screenshots, 'before.png'), PNG);
      await f.open(f.page);
      await f.draw(f.page);
      const drawing = await f.waitFor(s => s.elements.length === 1, 'drawing was not saved');
      await fs.writeFile(path.join(f.directory, 'inbox', 'assistant.json'), JSON.stringify({ elements: [{ ...drawing.elements[0], id: 'assistant-rectangle', x: drawing.elements[0].x + 170 }] }));
      await f.waitFor(s => s.elements.some(e => e.id === 'assistant-rectangle'), 'inbox was not merged');
      const bounds = await f.page.locator('.excalidraw').boundingBox();
      await f.page.keyboard.press('t'); await f.page.mouse.click(bounds.x + 450, bounds.y + 350);
      await f.page.keyboard.type('Our love spot'); await f.page.keyboard.press('Escape');
      await f.waitFor(s => s.elements.some(e => e.text === 'Our love spot'), 'text was not saved');
      await fs.writeFile(path.join(f.screenshots, 'new.png'), await f.page.screenshot({ clip: { x: 480, y: 160, width: 850, height: 550 } }));
      await f.waitFor(s => s.elements.filter(e => e.type === 'image').length === 1, 'new screenshot did not land');
      await new Promise(resolve => setTimeout(resolve, 1600));
      const picture = await fs.readFile(path.join(f.directory, 'view.png'));
      assert.equal(picture.subarray(1, 4).toString(), 'PNG');
      assert.equal(await f.page.locator('.excalidraw.theme--dark').count(), colorScheme === 'dark' ? 1 : 0);
      assert.deepEqual(await f.page.locator('.love-spot [role="alert"]').allTextContents(), []);
      await f.page.keyboard.press('Shift+1');
      await fs.mkdir('/tmp/love-spot-shots', { recursive: true });
      await fs.writeFile(`/tmp/love-spot-shots/view-${colorScheme}.png`, picture);
      await f.page.screenshot({ path: `/tmp/love-spot-shots/${colorScheme}.png` });
      assert.deepEqual(f.errors, []);
      // Excalidraw lists a CDN fallback in each FontFace; CSP blocks it. Only local fonts may actually load.
      assert.deepEqual(f.responses.filter(r => r.url.startsWith('https:')), []);
      assert.ok(f.responses.some(r => r.url.includes('/love-spot-assets/fonts/') && r.status === 200));
    } finally { await f.close(); }
  }
});
