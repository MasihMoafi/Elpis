const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

async function startText(page, text) {
  const bounds = await page.locator('.excalidraw').boundingBox();
  await page.mouse.click(bounds.x + 450, bounds.y + 220);
  await page.keyboard.press('t');
  await page.mouse.click(bounds.x + 450, bounds.y + 220);
  await page.locator('textarea.excalidraw-wysiwyg').waitFor();
  await page.keyboard.type(text);
}

test('a competing edit of the same note cannot replace the active verdict', async () => {
  const f = await loveSpotFixture();
  let release, held;
  try {
    await f.open(f.page); await startText(f.page, 'Agent asks for a verdict'); await f.page.keyboard.press('Escape');
    await f.waitFor(s => s.elements.some(e => e.text === 'Agent asks for a verdict'), 'seed did not save');
    const other = await f.newPage(); await f.open(other);
    const gate = new Promise(resolve => { release = resolve; });
    await f.page.route('**/api/love-spot', async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const drawing = route.request().postDataJSON();
      if (!held && drawing.elements.some(e => e.text === 'My verdict')) { held = drawing; await gate; }
      return route.continue();
    });
    await f.page.keyboard.press('Enter'); await f.page.locator('textarea.excalidraw-wysiwyg').waitFor();
    await f.page.keyboard.press('ControlOrMeta+a'); await f.page.keyboard.type('My verdict');
    await f.waitFor(() => held, 'the local verdict save was not held');
    const mine = held.elements.find(e => e.text === 'My verdict'), remote = await f.scene();
    // Pin a stale editor's empty commit above every local keystroke version.
    // The real store must retain it until this writer explicitly retries.
    remote.elements = remote.elements.map(e => e.id === mine.id
      ? { ...e, text: '', originalText: '', isDeleted: true, version: mine.version + 100, versionNonce: 0 } : e);
    const response = await other.request.post(new URL('/api/love-spot', f.url).href, { data: remote, headers: { Origin: new URL(f.url).origin } });
    assert.equal(response.status(), 200);
    const deleted = (await f.scene()).elements.find(e => e.id === mine.id);
    assert.equal(deleted.isDeleted, true); assert.ok(deleted.version > mine.version);
    await f.page.waitForTimeout(500);
    const input = f.page.locator('textarea.excalidraw-wysiwyg');
    assert.equal(await input.count(), 1, 'remote text replacement ended the active edit');
    assert.equal(await input.inputValue(), 'My verdict', 'remote text replacement erased the active verdict');
    release(); await f.page.keyboard.press('Control+s');
    await f.waitFor(s => s.elements.some(e => e.id === mine.id && e.text === 'My verdict' && !e.isDeleted), 'Ctrl+S did not beat the stale deletion');
    await f.page.keyboard.type(' remains here'); await f.page.keyboard.press('Control+s');
    await f.page.keyboard.press('Escape');
    await f.waitFor(s => s.elements.some(e => e.text === 'My verdict remains here' && !e.isDeleted), 'the winning remote version discarded the local verdict');
  } finally { release?.(); await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`active text survives two-window updates and Ctrl+S · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    await f.open(f.page);
    const other = await f.newPage(); await f.open(other);
    await startText(f.page, 'My verdict: ');
    const input = f.page.locator('textarea.excalidraw-wysiwyg');
    await f.waitFor(s => s.elements.some(e => e.text === 'My verdict: '), 'keystrokes did not save while editing');
    await f.draw(other, 200);
    await f.page.keyboard.type('keep every word', { delay: 30 });
    await f.page.keyboard.press('Control+s');
    assert.equal(await input.inputValue(), 'My verdict: keep every word');
    await f.page.getByRole('status', { name: 'Drawing save status' }).filter({ hasText: 'Saved' }).waitFor();
    await f.waitFor(s => s.elements.some(e => e.text === 'My verdict: keep every word' && !e.isDeleted), 'Ctrl+S lost active text');
    // Existing notes, including an agent's blue note, use the same text editor.
    await f.page.keyboard.press('Escape');
    await f.page.keyboard.press('Enter');
    await input.waitFor(); await f.page.keyboard.press('ControlOrMeta+a');
    await f.page.keyboard.type('Revised verdict');
    await f.draw(other, 300);
    await f.page.keyboard.press('Meta+s');
    await f.waitFor(s => s.elements.some(e => e.text === 'Revised verdict' && !e.isDeleted), 'Cmd+S lost the existing note');
    assert.equal(await input.inputValue(), 'Revised verdict');
    const output = path.join(os.homedir(), '.cache/elpis-tests/lsave'); await fs.mkdir(output, { recursive: true });
    await f.page.screenshot({ path: path.join(output, `saved-${colorScheme}.png`) });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('failed saves retain text and recover an interrupted edit after reload', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    await f.page.route('**/api/love-spot', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test disk unavailable' }) }) : route.continue());
    await startText(f.page, 'This verdict must survive');
    await f.page.keyboard.press('Control+s');
    await f.page.getByRole('alert').filter({ hasText: 'Test disk unavailable' }).waitFor();
    assert.equal(await f.page.locator('textarea.excalidraw-wysiwyg').inputValue(), 'This verdict must survive');
    assert.ok(!(await f.scene()).elements.some(e => e.text === 'This verdict must survive'), 'negative case must prevent the server write');
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.page.unroute('**/api/love-spot'); await f.open(f.page);
    await f.waitFor(s => s.elements.some(e => e.text === 'This verdict must survive' && !e.isDeleted), 'journal did not restore interrupted text');
    await f.page.waitForTimeout(500);
    assert.equal((await f.scene()).elements.filter(e => e.text === 'This verdict must survive' && !e.isDeleted).length, 1, 'recovery duplicated text');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('navigation and window close flush the final keystroke', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page); await startText(f.page, 'Before navigation');
    await f.page.getByRole('button', { name: 'New page', exact: true }).click();
    await f.waitFor(s => s.page?.name === 'Page 2', 'page did not switch');
    const old = JSON.parse(await fs.readFile(path.join(f.directory, 'pages/Current page.excalidraw'), 'utf8'));
    assert.ok(old.elements.some(e => e.text === 'Before navigation' && !e.isDeleted));
    const other = await f.newPage(); await f.open(other); await startText(other, 'Before close');
    await other.close({ runBeforeUnload: true });
    await f.waitFor(s => s.elements.some(e => e.text === 'Before close' && !e.isDeleted), 'close lost final keystrokes');
  } finally { await f.close(); }
});

test('a remote page switch defers until the edit ends and flushes to the original page', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page); const other = await f.newPage(); await f.open(other);
    await startText(f.page, 'Keep this page verdict');
    await other.getByRole('button', { name: 'New page', exact: true }).click();
    await f.waitFor(s => s.page?.name === 'Page 2', 'other window did not switch pages');
    await f.page.waitForTimeout(250);
    assert.equal(await f.page.locator('textarea.excalidraw-wysiwyg').inputValue(), 'Keep this page verdict');
    await f.page.keyboard.type(' with final words'); await f.page.keyboard.press('Control+s');
    await f.page.getByRole('status', { name: 'Drawing save status' }).filter({ hasText: 'Saved' }).waitFor();
    await f.page.keyboard.press('Escape');
    await f.page.getByRole('button', { name: 'Pages', exact: true }).filter({ hasText: 'Page 2' }).waitFor();
    const old = JSON.parse(await fs.readFile(path.join(f.directory, 'pages/Current page.excalidraw'), 'utf8'));
    assert.ok(old.elements.some(e => e.text === 'Keep this page verdict with final words' && !e.isDeleted));
    assert.equal((await f.scene()).elements.length, 0);
  } finally { await f.close(); }
});

test('a failed page-change save keeps the current board and its text', async () => {
  const f = await loveSpotFixture();
  try {
    await f.open(f.page);
    await f.page.route('**/api/love-spot', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Test save refused' }) }) : route.continue());
    await startText(f.page, 'Do not leave my verdict');
    await f.page.getByRole('button', { name: 'New page', exact: true }).click();
    await f.page.getByRole('alert').filter({ hasText: 'Test save refused' }).waitFor();
    assert.notEqual((await f.scene()).page?.name, 'Page 2');
    await f.page.unroute('**/api/love-spot'); await f.page.getByRole('button', { name: 'Retry', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.text === 'Do not leave my verdict' && !e.isDeleted), 'retry lost the text');
  } finally { await f.close(); }
});
