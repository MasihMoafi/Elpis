const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
const add = (page, name) => page.getByRole('button', { name: `Add ${name} to drawing`, exact: true });
const tray = page => page.getByRole('region', { name: 'New screenshots', exact: true });

for (const colorScheme of ['light', 'dark']) test(`screenshots before the first Love Spot visit remain private and reach both windows · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme, prepareScreenshots: screenshots => fs.writeFile(path.join(screenshots, 'old.png'), PNG) });
  let dock;
  try {
    await fs.writeFile(path.join(f.screenshots, 'before-opening.png'), PNG);
    await f.page.waitForTimeout(400);
    assert.equal(await f.page.locator('.excalidraw').count(), 0, 'background capture must preserve lazy editor loading');
    assert.deepEqual((await f.scene()).elements, [], 'capture must not share private screenshots');
    await f.open(f.page);
    await add(f.page, 'before-opening.png').waitFor();
    assert.equal(await add(f.page, 'old.png').count(), 0, 'startup screenshots must stay excluded');
    const { startDesktopServer } = await import('../bridge/server.mjs');
    const client = new Proxy(f.emitter, { get(target, key) { return key in target ? Reflect.get(target, key) : async () => ({}); } });
    dock = await startDesktopServer({ client, loveSpot: { directory: f.directory, screenshots: f.screenshots }, trashFile: path.join(f.root, 'dock-trash.json') });
    const other = await f.newPage(dock.url);
    await other.goto(`${new URL(dock.url).origin}/love-spot.html`);
    await other.locator('.excalidraw canvas').first().waitFor();
    await add(other, 'before-opening.png').waitFor();
    const output = path.join(os.homedir(), '.cache/elpis-tests/love-screenshots'); await fs.mkdir(output, { recursive: true });
    await f.page.screenshot({ path: path.join(output, `${colorScheme}.png`) });
    await add(other, 'before-opening.png').focus(); await other.keyboard.press('Enter');
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted && e.type === 'image').length === 1, 'Add must place one screenshot');
    await tray(f.page).waitFor({ state: 'detached' }); await tray(other).waitFor({ state: 'detached' });
    await f.page.reload(); await f.open(f.page); await f.page.waitForTimeout(400);
    assert.equal(await tray(f.page).count(), 0, 'a consumed screenshot must not reappear');
    assert.equal((await f.scene()).elements.filter(e => e.type === 'image').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { if (dock) await dock.close(); await f.close(); }
});

test('screenshots taken between Love Spot visits follow the current page and complete partial files', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor(s => s.elements.length === 1, 'seed page must save');
    const original = (await f.scene()).page;
    await f.page.getByRole('button', { name: 'New page', exact: true }).click();
    await f.waitFor(s => s.page?.session !== original.session, 'new board page must open');
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.page.locator('.excalidraw').waitFor({ state: 'detached' });
    await fs.writeFile(path.join(f.screenshots, 'away.png'), PNG);
    await fs.writeFile(path.join(f.screenshots, 'partial.png'), PNG.subarray(0, 10));
    await f.page.waitForTimeout(450);
    await f.open(f.page);
    await add(f.page, 'away.png').waitFor();
    assert.equal(await add(f.page, 'partial.png').count(), 0, 'partial PNG must wait');
    assert.equal((await f.scene()).elements.length, 0, 'new screenshots must remain private on the current page');
    await fs.writeFile(path.join(f.screenshots, 'partial.png'), PNG);
    await add(f.page, 'partial.png').waitFor();
    const other = await f.newPage(); await f.open(other);
    await add(other, 'away.png').waitFor(); await add(other, 'partial.png').waitFor();
    await add(f.page, 'away.png').click();
    const scene = await f.waitFor(s => s.elements.some(e => e.type === 'image'), 'screenshot must land on the current page');
    assert.notEqual(scene.page.session, original.session);
    assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, 'pages', `${original.name}.excalidraw`), 'utf8')).elements.length, 1, 'previous page must remain unchanged');
    await other.getByRole('button', { name: 'Dismiss partial.png', exact: true }).click();
    await tray(f.page).waitFor({ state: 'detached' }); await tray(other).waitFor({ state: 'detached' });
    assert.equal((await f.scene()).elements.filter(e => e.type === 'image').length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
