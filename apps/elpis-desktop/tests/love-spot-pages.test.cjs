const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`Love Spot pages: mouse/keyboard create, rename and switch in two windows (${colorScheme})`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    await fs.mkdir(path.join(f.directory, 'pages'), { recursive: true });
    await fs.writeFile(path.join(f.directory, 'pages', '2026-10-18-morning.excalidraw'), JSON.stringify({ elements: [], files: {} }));
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'original page did not save');
    const other = await f.newPage(); await f.open(other);
    await f.page.getByRole('button', { name: 'Pages', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'New page', exact: true }).click();
    await f.waitFor(s => s.page?.name === 'Page 3' && s.elements.length === 0, 'new page was not empty');
    await other.getByRole('button', { name: 'Pages', exact: true }).waitFor();
    await other.getByText('Page 3', { exact: true }).waitFor();
    await f.draw(other);
    await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 1, 'the other window kept the old drawing');
    await f.page.getByRole('button', { name: 'Pages', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Rename page', exact: true }).click();
    const input = f.page.getByRole('textbox', { name: 'Page name', exact: true });
    await input.fill('Quiet ideas'); await input.press('Enter');
    await other.getByText('Quiet ideas', { exact: true }).waitFor();
    await f.page.getByRole('button', { name: 'Pages', exact: true }).click();
    const archived = f.page.getByRole('menuitem', { name: /2026-10-18-morning/ });
    await archived.waitFor();
    await fs.mkdir('/tmp/love-spot-pages-shots', { recursive: true });
    await f.page.screenshot({ path: `/tmp/love-spot-pages-shots/${colorScheme}.png` });
    await archived.click();
    await other.getByText('2026-10-18-morning', { exact: true }).waitFor();
    await f.waitFor(s => s.page?.name === '2026-10-18-morning' && !s.elements.length, 'archive did not load');
    await f.page.getByRole('button', { name: 'Pages', exact: true }).click();
    await f.page.getByRole('menuitem', { name: /Current page/ }).click();
    await f.waitFor(s => s.page?.name === 'Current page' && s.elements.filter(e => !e.isDeleted).length === 1, 'original drawing was lost');
    await f.page.waitForTimeout(500);
    assert.equal((await f.scene()).elements.filter(e => !e.isDeleted).length, 1, 'a delayed save mixed drawings');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Love Spot light images: tall screenshots and pasted SVGs shrink, deletion prunes disk files and undo restores pixels', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    const dataURL = await f.page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 3200;
      const context = canvas.getContext('2d'); context.fillStyle = '#619c87'; context.fillRect(0, 0, 600, 3200);
      return canvas.toDataURL('image/png');
    });
    await fs.writeFile(path.join(f.screenshots, 'tall.png'), Buffer.from(dataURL.split(',')[1], 'base64'));
    await f.page.getByRole('button', { name: 'Add tall.png to drawing', exact: true }).click();
    let scene = await f.waitFor(s => s.elements.some(e => e.type === 'image' && !e.isDeleted), 'image did not save');
    const imageSize = async data => f.page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode(); return [image.naturalWidth, image.naturalHeight];
    }, data);
    assert.deepEqual(await imageSize(Object.values(scene.files)[0].dataURL), [300, 1600]);
    await f.page.waitForTimeout(300);
    await f.page.locator('.excalidraw').click({ position: { x: 900, y: 500 } });
    await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.press('Delete');
    await f.waitFor(s => s.elements.every(e => e.isDeleted) && Object.keys(s.files).length === 0, 'deleted image bytes stayed on disk');
    await f.page.keyboard.press('ControlOrMeta+z');
    scene = await f.waitFor(s => s.elements.some(e => !e.isDeleted) && Object.keys(s.files).length === 1, 'undo lost the image');
    assert.deepEqual(await imageSize(Object.values(scene.files)[0].dataURL), [300, 1600]);
    // Paste a vector with large intrinsic dimensions using the real clipboard and key event.
    await f.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await f.page.evaluate(() => navigator.clipboard.writeText('<svg xmlns="http://www.w3.org/2000/svg" width="3200" height="800"><rect width="3200" height="800" fill="#7950a3"/></svg>'));
    await f.page.keyboard.press('ControlOrMeta+v');
    scene = await f.waitFor(s => s.elements.filter(e => e.type === 'image' && !e.isDeleted).length === 2, 'SVG paste did not save');
    for (const file of Object.values(scene.files)) assert.ok(Math.max(...await imageSize(file.dataURL)) <= 1600);
    const original = scene.elements.find(e => e.type === 'image');
    await fs.writeFile(path.join(f.directory, 'inbox', 'large-image.json'), JSON.stringify({
      elements: [{ ...original, id: 'inbox-image-element', fileId: 'inbox-image', version: 1, x: original.x + 800 }],
      files: { 'inbox-image': { id: 'inbox-image', mimeType: 'image/png', dataURL, created: Date.now() } },
    }));
    await f.waitFor(async s => s.files['inbox-image'] && Math.max(...await imageSize(s.files['inbox-image'].dataURL)) <= 1600, 'an image placed through the inbox was not resized');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('an unreadable page list is reported in Love Spot, and the rest of the app keeps working', async () => {
  const f = await loveSpotFixture({ colorScheme: 'dark' });
  try {
    const crashes = []; f.page.on('pageerror', error => crashes.push(error.message));
    await f.page.route('**/api/love-spot/pages', route => route.request().method() === 'GET' ? route.fulfill({ contentType: 'application/json', body: '{}' }) : route.continue());
    await f.open(f.page);
    await f.page.locator('.excalidraw canvas').first().waitFor();
    await f.page.getByRole('button', { name: 'Pages', exact: true }).click();
    await f.page.getByRole('menuitem', { name: /could not read \(Love Spot pages\)/ }).waitFor();
    await f.page.keyboard.press('Escape');
    await f.page.getByRole('button', { name: 'Observability', exact: true }).waitFor();
    assert.deepEqual(crashes, [], 'one malformed reply must not take the whole app down');
  } finally { await f.close(); }
});
