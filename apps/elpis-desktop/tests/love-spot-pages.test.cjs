const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const { createTestTempDir, removeTestTempDir } = require('./temp-root.cjs');

test('opening a saved page does not rewrite it; the first real edit still saves', async () => {
  const shape = { type: 'rectangle', x: 0, y: 0, width: 120, height: 80, version: 1, versionNonce: 1 };
  const original = JSON.stringify({ elements: [{ ...shape, id: 'saved-rectangle' }, { ...shape, id: 'deleted-rectangle', isDeleted: true }], files: {}, appState: { viewBackgroundColor: '#ffffff' } });
  const f = await loveSpotFixture({ prepareDirectory: async directory => {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'scene.excalidraw'), original);
  } });
  try {
    const writes = [];
    f.page.on('request', request => { if (request.method() === 'POST' && ['/api/love-spot', '/api/love-spot/picture'].includes(new URL(request.url()).pathname)) writes.push(request); });
    await f.open(f.page); await f.page.waitForTimeout(1400);
    assert.equal(await fs.readFile(path.join(f.directory, 'scene.excalidraw'), 'utf8'), original, 'opening must not serialize and resend unchanged image data');
    assert.equal(writes.length, 0);
    await f.draw(f.page);
    const scene = await f.waitFor(s => s.elements.filter(e => !e.isDeleted).length === 2, 'the first edit must persist');
    assert.ok(scene.elements.some(e => e.id === 'deleted-rectangle' && e.isDeleted), 'the loaded tombstone must survive the first edit');
    assert.ok(writes.length > 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('image previews refresh, and normalized file bytes do not cause a save loop', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(f.screenshots, 'pixel-change.png'), png);
    await f.page.getByRole('button', { name: 'Add pixel-change.png to drawing', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.type === 'image'), 'the placed image must save');
    const currentPicture = async () => {
      const hash = createHash('sha256').update(await fs.readFile(path.join(f.directory, 'scene.excalidraw'))).digest('hex');
      return await fs.readFile(path.join(f.directory, '.view-revision'), 'utf8').catch(() => '') === hash;
    };
    await f.waitFor(currentPicture, 'the placed image must refresh the picture');
    const before = await fs.readFile(path.join(f.directory, 'view.png'));
    const scene = await f.scene(), image = scene.elements.find(e => e.type === 'image');
    const dataURL = await f.page.evaluate(async url => {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0); return canvas.toDataURL();
    }, scene.files[image.fileId].dataURL);
    assert.notEqual(dataURL, scene.files[image.fileId].dataURL, 'normalization must change the encoded bytes');
    let saves = 0;
    f.page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/love-spot') saves++; });
    await fs.writeFile(path.join(f.directory, 'inbox', 'pixels.json'), JSON.stringify({ elements: [], files: { [image.fileId]: { ...scene.files[image.fileId], dataURL, loveSpotResized: true } } }));
    await f.waitFor(s => s.files[image.fileId]?.dataURL === dataURL, 'normalized pixels must reach the saved scene');
    await f.page.waitForTimeout(1400);
    assert.equal(saves, 0, 'an immutable editor file must not repeatedly resend its original bytes');
    await f.draw(f.page);
    await f.waitFor(s => s.elements.some(e => e.type === 'rectangle'), 'the next real edit must save');
    await f.waitFor(currentPicture, 'the next real edit must refresh the picture');
    assert.notDeepEqual(await fs.readFile(path.join(f.directory, 'view.png')), before);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`Love Spot pages: mouse/keyboard create, rename and switch in two windows (${colorScheme})`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    await fs.mkdir(path.join(f.directory, 'pages'), { recursive: true });
    await fs.writeFile(path.join(f.directory, 'pages', '2026-10-18-morning.excalidraw'), JSON.stringify({ elements: [], files: {} }));
    await f.open(f.page); await f.draw(f.page);
    await f.waitFor(s => s.elements.some(e => !e.isDeleted), 'original page did not save');
    const other = await f.newPage(); await f.open(other);
    await f.page.getByRole('button', { name: 'New page', exact: true }).click();
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

test('Love Spot creates a page from its toolbar and keeps Agents available', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    await f.page.getByRole('button', { name: 'New page', exact: true }).click();
    await f.waitFor(s => s.page?.name === 'Page 2' && s.elements.length === 0, 'the direct New page action did not create an empty page');
    const agents = f.page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true });
    await agents.click();
    await f.page.getByRole('menuitem', { name: 'Add Researcher', exact: true }).click();
    assert.equal(await f.page.getByRole('button', { name: 'Inspect Researcher', exact: true }).count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Love Spot can delete a page, and cancelling leaves its drawing intact', async () => {
  const oldXdgDataHome = process.env.XDG_DATA_HOME;
  const tempBase = path.join(os.homedir(), '.cache/elpis-tests');
  await fs.mkdir(tempBase, { recursive: true });
  const trashRoot = createTestTempDir(path.join(tempBase, 'love-spot-page-trash-'));
  process.env.XDG_DATA_HOME = path.join(trashRoot, 'data');
  let f;
  try {
    f = await loveSpotFixture();
    await f.open(f.page);
    await f.page.getByRole('button', { name: 'New page', exact: true }).click();
    await f.waitFor(s => s.page?.name === 'Page 2', 'the page to delete was not created');
    await f.draw(f.page);
    await f.waitFor(s => s.page?.name === 'Page 2' && s.elements.some(e => !e.isDeleted), 'the drawing to delete was not saved');
    await f.page.getByRole('button', { name: 'Delete current page', exact: true }).click();
    let dialog = f.page.getByRole('alertdialog');
    await dialog.getByText('Delete “Page 2”?', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    const cancelled = await f.scene();
    assert.equal(cancelled.page.name, 'Page 2', 'cancelling must leave the active page in place');
    assert.ok(cancelled.elements.some(e => !e.isDeleted), 'cancelling must keep the drawing');
    await fs.access(path.join(f.directory, 'pages', 'Page 2.excalidraw'));

    await f.page.getByRole('button', { name: 'Delete current page', exact: true }).click();
    dialog = f.page.getByRole('alertdialog');
    await dialog.getByText('Delete “Page 2”?', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Delete page', exact: true }).click();
    await f.waitFor(s => s.page?.name === 'Page 3', 'deleting the current page must open a fresh page');
    await f.page.getByRole('button', { name: 'Pages', exact: true }).click();
    await f.page.getByRole('menuitem', { name: /^Current page\b/ }).waitFor();
    await f.page.getByRole('menuitem', { name: /^Page 2\b/ }).waitFor({ state: 'detached' });
    assert.equal(await f.page.getByRole('menuitem', { name: /^Page 2\b/ }).count(), 0, 'deleted pages must leave the list');
    assert.equal(await f.page.getByRole('menuitem', { name: /^Current page\b/ }).count(), 1, 'other pages must remain available');
    const trashed = JSON.parse(await fs.readFile(path.join(trashRoot, 'data', 'Trash', 'files', 'Page 2.excalidraw'), 'utf8'));
    assert.ok(trashed.elements.some(e => !e.isDeleted), 'the recoverable page must keep its drawing');
    assert.deepEqual(f.errors, []);
  } finally {
    try { if (f) await f.close(); }
    finally {
      if (oldXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdgDataHome;
      removeTestTempDir(trashRoot);
    }
  }
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
