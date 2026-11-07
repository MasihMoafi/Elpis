type Scene = { elements: { id: string; type: string }[] };
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cts');
const nonMatildaElements =  (scene: Scene) => scene.elements.filter(e => !e.id.startsWith('love-'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');

test('Love Spot private tray is shared across windows; dismiss persists and mouse drag places only the chosen image', async () => {
  const f = await loveSpotFixture({ prepareScreenshots: (screenshots: string) => fs.writeFile(path.join(screenshots, 'baseline.png'), PNG) });
  try {
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor((s: Scene) => s.elements.filter(e => !e.id.startsWith('love-')).length === 1, 'drawing was not saved');
    const other = await f.newPage(); await f.open(other);
    const tray = (page: { getByRole: typeof f.page.getByRole }) => page.getByRole('region', { name: 'New screenshots', exact: true });
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
    await f.waitFor((s: Scene) => nonMatildaElements(s).filter(e => e.type === 'image').length === 1, 'drag did not place the screenshot');
    await tray(f.page).waitFor({ state: 'detached' }); await tray(other).waitFor({ state: 'detached' });
    await f.page.waitForTimeout(400);
    assert.equal(nonMatildaElements(await f.scene()).filter(e => e.type === 'image').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
