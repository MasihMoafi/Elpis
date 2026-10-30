const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const nonMatildaElements = scene => scene.elements.filter(e => !e.id.startsWith('love-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');

test('Love Spot real bridge: mouse strokes sync, stale windows retain both, delete syncs, typing survives navigation', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    assert.equal(f.requests.some(url => url.includes('/love-spot-assets/')), false);
    await f.open(page);
    await f.draw(page);
    await f.waitFor(s => nonMatildaElements(s).filter(e => !e.isDeleted).length === 1, 'first mouse stroke was not saved');
    const other = await f.newPage(); await f.open(other);
    await f.draw(other, 140);
    await f.waitFor(s => nonMatildaElements(s).filter(e => !e.isDeleted).length === 2, 'second window lost a stroke');
    // Deleting from the first page must also delete the other window's stroke: it has to have arrived.
    const at = Date.now();
    await page.bringToFront(); await page.waitForTimeout(200);
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.press('Delete');
    await f.waitFor(s => nonMatildaElements(s).filter(e => !e.isDeleted).length === 0, 'remote stroke did not reach the first page', 1000);
    assert.ok(Date.now() - at < 1000);
    await page.waitForTimeout(1200);
    assert.deepEqual(await page.locator('.love-spot [role="alert"]').allTextContents(), [], 'clearing the drawing must also export an empty picture');
    assert.equal((await fs.readFile(path.join(f.directory, 'view.png'))).subarray(1, 4).toString(), 'PNG');
    const bounds = await page.locator('.excalidraw').boundingBox();
    await page.keyboard.press('t'); await page.mouse.click(bounds.x + 500, bounds.y + 260);
    await page.keyboard.type('Our love spot'); await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.text === 'Our love spot' && !e.isDeleted), 'typing was lost when leaving the page');
    assert.equal((await f.scene()).elements.find(e => e.text === 'Our love spot').strokeColor, '#2f9e44', 'Masih writes in green; blue is the assistant\'s');
    await f.open(page);
    await page.keyboard.press('ControlOrMeta+a');
    assert.equal(nonMatildaElements(await f.scene()).filter(e => e.type === 'text' && !e.isDeleted).length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Love Spot real bridge: screenshots wait for a click, inbox and PNG export work; four tray captures', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const f = await loveSpotFixture({ colorScheme, prepareScreenshots: screenshots => fs.writeFile(path.join(screenshots, 'before.png'), PNG) });
    try {
      await f.open(f.page);
      await f.draw(f.page);
      const drawing = await f.waitFor(s => nonMatildaElements(s).length === 1, 'drawing was not saved');
      const [rectangle] = nonMatildaElements(drawing);
      await fs.writeFile(path.join(f.directory, 'inbox', 'assistant.json'), JSON.stringify({ elements: [{ ...rectangle, id: 'assistant-rectangle', x: rectangle.x + 170 }] }));
      await f.waitFor(s => s.elements.some(e => e.id === 'assistant-rectangle'), 'inbox was not merged');
      const bounds = await f.page.locator('.excalidraw').boundingBox();
      await f.page.keyboard.press('t'); await f.page.mouse.click(bounds.x + 450, bounds.y + 350);
      await f.page.keyboard.type('Our love spot'); await f.page.keyboard.press('Escape');
      await f.waitFor(s => s.elements.some(e => e.text === 'Our love spot'), 'text was not saved');
      await f.page.waitForTimeout(1700);
      const before = await fs.readFile(path.join(f.directory, 'view.png'));
      await fs.writeFile(path.join(f.screenshots, 'new.png'), await f.page.screenshot({ clip: { x: 480, y: 160, width: 850, height: 550 } }));
      const tray = f.page.getByRole('region', { name: 'New screenshots', exact: true });
      await tray.getByRole('button', { name: 'Add new.png to drawing', exact: true }).waitFor();
      await f.page.waitForTimeout(1100);
      assert.equal(nonMatildaElements(await f.scene()).filter(e => e.type === 'image').length, 0);
      assert.deepEqual(await fs.readFile(path.join(f.directory, 'view.png')), before);
      await fs.mkdir('/tmp/love-spot-shots', { recursive: true });
      for (const width of [1280, 1440]) {
        await f.page.setViewportSize({ width, height: 960 });
        await f.page.waitForTimeout(150);
        const box = await tray.boundingBox(), tools = await f.page.locator('.excalidraw .App-toolbar').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.height < 160);
        assert.ok(tools && tools.y >= box.y + box.height, 'tray must leave the toolbar clear');
        assert.ok(await tray.evaluate(el => el.scrollWidth <= el.clientWidth));
        await f.page.screenshot({ path: `/tmp/love-spot-shots/${colorScheme}-${width}.png` });
      }
      await tray.getByRole('button', { name: 'Add new.png to drawing', exact: true }).click();
      await f.waitFor(s => nonMatildaElements(s).filter(e => e.type === 'image').length === 1, 'chosen screenshot did not land');
      await tray.waitFor({ state: 'detached' });
      await new Promise(resolve => setTimeout(resolve, 1600));
      const picture = await fs.readFile(path.join(f.directory, 'view.png'));
      assert.equal(picture.subarray(1, 4).toString(), 'PNG');
      assert.equal(await f.page.locator('.excalidraw.theme--dark').count(), colorScheme === 'dark' ? 1 : 0);
      assert.deepEqual(await f.page.locator('.love-spot [role="alert"]').allTextContents(), []);
      await f.page.keyboard.press('Shift+1');
      await fs.writeFile(`/tmp/love-spot-shots/view-${colorScheme}.png`, picture);
      await f.page.screenshot({ path: `/tmp/love-spot-shots/${colorScheme}.png` });
      assert.deepEqual(f.errors, []);
      // Excalidraw lists a CDN fallback in each FontFace; CSP blocks it. Only local fonts may actually load.
      assert.deepEqual(f.responses.filter(r => r.url.startsWith('https:')), []);
      assert.ok(f.responses.some(r => r.url.includes('/love-spot-assets/fonts/') && r.status === 200));
    } finally { await f.close(); }
  }
});

test('Love Spot private tray is shared across windows; dismiss persists and mouse drag places only the chosen image', async () => {
  const f = await loveSpotFixture({ prepareScreenshots: screenshots => fs.writeFile(path.join(screenshots, 'baseline.png'), PNG) });
  try {
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor(s => s.elements.filter(e => !e.id.startsWith('love-')).length === 1, 'drawing was not saved');
    const other = await f.newPage(); await f.open(other);
    const tray = page => page.getByRole('region', { name: 'New screenshots', exact: true });
    await fs.writeFile(path.join(f.screenshots, 'private.png'), PNG);
    await tray(f.page).getByRole('button', { name: 'Dismiss private.png', exact: true }).waitFor();
    const dismiss = tray(other).getByRole('button', { name: 'Dismiss private.png', exact: true });
    await dismiss.focus(); await other.keyboard.press('Enter');
    await tray(f.page).waitFor({ state: 'detached' }); await tray(other).waitFor({ state: 'detached' });
    await other.getByRole('button', { name: 'Workflows', exact: true }).click(); await f.open(other);
    await other.waitForTimeout(500);
    assert.equal(await tray(other).count(), 0);
    assert.equal(nonMatildaElements(await f.scene()).filter(e => e.type === 'image').length, 0);
    await fs.writeFile(path.join(f.screenshots, 'chosen.png'), PNG);
    const add = tray(f.page).getByRole('button', { name: 'Add chosen.png to drawing', exact: true });
    await add.waitFor(); await tray(other).getByRole('button', { name: 'Add chosen.png to drawing', exact: true }).waitFor();
    await add.dragTo(f.page.locator('.excalidraw canvas.interactive'), { targetPosition: { x: 500, y: 300 } });
    await f.waitFor(s => nonMatildaElements(s).filter(e => e.type === 'image').length === 1, 'drag did not place the screenshot');
    await tray(f.page).waitFor({ state: 'detached' }); await tray(other).waitFor({ state: 'detached' });
    await f.page.waitForTimeout(400);
    assert.equal(nonMatildaElements(await f.scene()).filter(e => e.type === 'image').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
