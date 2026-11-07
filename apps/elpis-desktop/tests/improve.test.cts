import type { Locator, Page } from 'playwright-core';

type Rect = { x: number; y: number; width: number; height: number };
type ImproveWindow = typeof window & { __captures: Rect[]; elpisDesktop: NonNullable<Window['elpisDesktop']> & { improve: NonNullable<NonNullable<Window['elpisDesktop']>['improve']> } };
type Fixture = { page: Page; posts: { path: string; body: { request: string; target: { image: string; id: string } } }[]; errors: string[]; close(): Promise<void> };
type Options = { colorScheme?: string; width?: number; height?: number; routes: Record<string, (body: { path?: string } | null) => unknown> };
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const path: typeof import('node:path') = require('node:path');
const { fixture }: { fixture(options: Options): Promise<Fixture> } = require('./parity-fixture.cjs');
const { assertDialogActionsExplained }: { assertDialogActionsExplained(dialog: Locator, reason: RegExp): Promise<void> } = require('./controls.cts');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=';
const row = { id: 'change-1', branch: 'improve/20261018-button', cwd: '/tmp/change', status: 'review', head: 'abc', dirty: false, diff: 'diff --git a/button b/button\n--- a/button\n+++ b/button\n@@ -1 +1 @@\n-Send\n+Go', checks: null, thread: { id: 'chat-a' } };
const checkedRow = { ...row, checks: { passed: true, head: 'abc', commands: [{ command: 'node --test', code: 0, output: 'tests 1\npass 1' }] } };
async function setup(colorScheme = 'light', failCapture = false, result = checkedRow) {
  let started = false, current: typeof row | typeof checkedRow = row;
  const f = await fixture({ colorScheme, width: 1200, height: 800, routes: {
    '/api/improvements': body => { if (body) { started = true; return row; } return { data: started ? [{ id: row.id, threadId: 'chat-a' }] : [] }; },
    '/api/improvements/source': () => ({ configured: true, path: '/tmp/elpis-source' }),
    '/api/improvements/change-1': () => current,
    '/api/improvements/change-1/check': () => current = result,
  } });
  await f.page.evaluate(({ PNG, failCapture }) => { const target = window as ImproveWindow; target.__captures = []; target.elpisDesktop.improve = { capture: async rect => { target.__captures.push(rect); if (failCapture) throw Error('Capture failed'); return { image: PNG }; } }; }, { PNG, failCapture });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  return f;
}
for (const colorScheme of ['light']) test(`Ctrl+K improvement opens a pointed chat and review with measured tests and no Try it or Keep (${colorScheme})`, async () => {
  const f = await setup(colorScheme), { page } = f;
  try {
    await page.keyboard.press('Control+k'); await page.getByRole('combobox', { name: 'Search or start a chat' }).fill('Improve Elpis');
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Improve Elpis' }); await dialog.waitFor();
    if (process.env.ELPIS_IMPROVE_SHOTS) { await fs.mkdir(process.env.ELPIS_IMPROVE_SHOTS, { recursive: true }); await page.screenshot({ animations: 'disabled', path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `improve-request-${colorScheme}.png`) }); }
    await dialog.getByRole('textbox', { name: 'What should change?' }).fill('Rename Send to Go');
    await dialog.getByRole('button', { name: 'Start change' }).click();
    await dialog.waitFor({ state: 'detached' });
    const sent = f.posts.find(post => post.path === '/api/improvements');
    assert.ok(sent);
    assert.equal(sent.body.request, 'Rename Send to Go'); assert.equal(sent.body.target.image, PNG);
    assert.match(sent.body.target.id, /app\/page.tsx#Home/);
    const review = page.getByRole('dialog', { name: 'Review Elpis change' });
    await review.getByText('Run build and tests on this commit.', { exact: true }).waitFor();
    // Masih, 22 Oct (the review dialog): "keep and try it should be deleted."
    for (const name of ['Try it', 'Keep']) assert.equal(await review.getByRole('button', { name, exact: true }).count(), 0, `${name} is gone`);
    assert.ok(await review.getByText('Go', { exact: true }).count());
    if (process.env.ELPIS_IMPROVE_SHOTS) { await fs.mkdir(process.env.ELPIS_IMPROVE_SHOTS, { recursive: true }); await page.screenshot({ animations: 'disabled', path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `improve-${colorScheme}.png`) }); }
    const checkResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/improvements/change-1/check');
    await review.getByRole('button', { name: 'Check build & tests', exact: true }).click(); assert.equal((await checkResponse).ok(), true);
    await review.getByText('Build and tests passed', { exact: true }).waitFor();
    if (process.env.ELPIS_IMPROVE_SHOTS) await page.screenshot({ animations: 'disabled', path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `improve-passed-${colorScheme}.png`) });
    assert.ok(f.posts.some(post => post.path === '/api/improvements/change-1/check'));
    assert.ok(f.posts.every(post => !post.path.startsWith('/improvements/')));
    await review.getByRole('button', { name: 'Close', exact: true }).click();
    const overlap = await page.evaluate(() => { const first = document.querySelector('.elpis-improve-review-button'), second = document.querySelector('[aria-label="Show side panel"]'); if (!first || !second) throw Error('Header controls missing'); const a = first.getBoundingClientRect(), b = second.getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; });
    assert.equal(overlap, false, 'review action shares the header layout without covering the panel control');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('the source folder chooser repairs setup without losing the requested change or starting a model', async () => {
  let configured = false;
  const f = await fixture({ width: 1100, height: 800, routes: {
    '/api/improvements/source': body => { if (!body) return { path: configured ? '/tmp/source' : null, configured }; if (body.path === '/tmp/wrong') return { __http: 400, error: 'This folder is not an Elpis source checkout.' }; configured = true; return { path: body.path, configured: true }; },
    '/api/improvements': () => ({ data: [] }),
  } });
  try {
    await f.page.evaluate(PNG => { const desktop = (window as ImproveWindow).elpisDesktop; desktop.improve = { capture: async () => ({ image: PNG }) }; desktop.chooseFolder = async () => '/tmp/wrong'; }, PNG);
    await f.page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const dialog = f.page.getByRole('dialog', { name: 'Improve Elpis' }); await dialog.waitFor();
    const request = dialog.getByRole('textbox', { name: 'What should change?' }); await request.fill('Keep this requested change');
    assert.equal(await dialog.getByRole('button', { name: 'Start change' }).isDisabled(), true);
    await assertDialogActionsExplained(dialog, /Choose.*Elpis source folder/i);
    await dialog.getByRole('button', { name: 'Choose source folder' }).click(); await dialog.getByRole('alert').waitFor();
    await dialog.getByRole('alert').filter({ hasText: 'This folder is not an Elpis source checkout.' }).waitFor();
    assert.equal(await request.inputValue(), 'Keep this requested change');
    await f.page.evaluate(() => { (window as ImproveWindow).elpisDesktop.chooseFolder = async () => '/tmp/source'; });
    await dialog.getByRole('button', { name: 'Choose source folder' }).click();
    await dialog.getByText('/tmp/source', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Start change' }).isEnabled(), true);
    assert.equal(f.posts.filter(p => p.path === '/api/improvements').length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light']) test(`source found enables Start change; empty request names its requirement (${colorScheme})`, async () => {
  const f = await setup(colorScheme), { page } = f;
  try {
    await page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const dialog = page.getByRole('dialog', { name: 'Improve Elpis' });
    await dialog.getByText('/tmp/elpis-source', { exact: true }).waitFor();
    const request = dialog.getByRole('textbox', { name: 'What should change?' });
    await request.fill('   ');
    assert.equal(await dialog.getByRole('button', { name: 'Start change' }).isDisabled(), true);
    if (process.env.ELPIS_IMPROVE_SHOTS) {
      await fs.mkdir(process.env.ELPIS_IMPROVE_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `requirements-${colorScheme}.png`) });
    }
    await assertDialogActionsExplained(dialog, /Describe.*change/i);
    await request.fill('Make the selected row readable');
    assert.equal(await dialog.getByRole('button', { name: 'Start change' }).isEnabled(), true);
    assert.equal(f.posts.filter(post => post.path === '/api/improvements').length, 0);
    await request.clear();
    await assertDialogActionsExplained(dialog, /Describe.*change/i);
  } finally { await f.close(); }
});

test('capture failure names the missing target beside Start change', async () => {
  const f = await setup('light', true);
  try {
    await f.page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const dialog = f.page.getByRole('dialog', { name: 'Improve Elpis' });
    await dialog.getByRole('textbox', { name: 'What should change?' }).fill('Keep my request');
    await assertDialogActionsExplained(dialog, /Capture.*region/i);
    assert.equal(f.posts.filter(post => post.path === '/api/improvements').length, 0);
  } finally { await f.close(); }
});

test('the shared footer explains a disabled primary action in another dialog', async () => {
  const f = await setup(), { page } = f;
  try {
    await page.locator('.thread-row[data-thread-id="chat-a"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: false }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByRole('textbox').clear();
    await assertDialogActionsExplained(dialog, /Enter a conversation name/);
    await dialog.getByRole('textbox').fill('Readable name');
    assert.equal(await dialog.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
  } finally { await f.close(); }
});

for (const colorScheme of ['light']) test(`right-clicking text captures its mapped row, preserves native preview pixels and truncates the path (${colorScheme})`, async () => {
  const f = await setup(colorScheme), { page } = f;
  try {
    // A long, short row like Settings > Advanced > Open config file; the text is a child of its mapped owner.
    await page.evaluate(() => {
      const owner = document.querySelector('.app-shell');
      const row = document.createElement('div'); row.id = 'pointed-row';
      row.setAttribute('data-elpis-source', 'components/settings/rows.tsx#SettingRow');
      row.style.cssText = 'position:fixed;left:300px;top:200px;width:850px;padding:16px;border:1px solid';
      row.innerHTML = '<strong>Open config file</strong><p>Open Configuration settings.</p>';
      const source = row.getAttribute('data-elpis-source'); if (!owner || !source) throw Error('Mapped row missing');
      for (const child of row.children) child.setAttribute('data-elpis-source', source);
      owner.append(row);
      (window as ImproveWindow).elpisDesktop.improve.capture = async rect => {
        (window as ImproveWindow).__captures.push(rect);
        const canvas = document.createElement('canvas'); canvas.width = rect.width; canvas.height = rect.height;
        const context = canvas.getContext('2d'); if (!context) throw Error('Canvas unavailable'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#222'; context.font = '16px sans-serif'; context.fillText('Open Configuration settings.', 16, 30);
        return { image: canvas.toDataURL('image/png') };
      };
    });
    const expected = await page.locator('#pointed-row').boundingBox();
    await page.locator('#pointed-row p').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Change this…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Improve Elpis' }); await dialog.waitFor();
    await dialog.getByRole('textbox', { name: 'What should change?' }).fill('the size of this - the alignment and consistency of the UI here is broken!');
    if (process.env.ELPIS_IMPROVE_SHOTS) {
      await fs.mkdir(process.env.ELPIS_IMPROVE_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `pointed-row-${colorScheme}.png`) });
    }
    const [capture] = await page.evaluate(() => (window as ImproveWindow).__captures); assert.ok(capture && expected);
    assert.ok(Math.abs(capture.height - expected.height) <= 1, `captured ${capture.height}px of the ${expected.height}px mapped row`);
    assert.ok(Math.abs(capture.width - expected.width) <= 1, 'capture must stay on the selected row');
    const pixels = await dialog.locator('img').evaluate(img => ({ natural: (img as HTMLImageElement).naturalWidth, shown: img.getBoundingClientRect().width }));
    assert.ok(pixels.shown >= pixels.natural - 1, JSON.stringify(pixels));
    const sourcePath = dialog.locator('[data-slot="improve-source-path"]');
    const title = await sourcePath.getAttribute('title'); assert.ok(title); assert.match(title, /apps\/elpis-desktop\//);
    assert.equal(await sourcePath.evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis');
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.setViewportSize({ width: 480, height: 650 });
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'narrow dialog keeps content inside its borders');
  } finally { await f.close(); }
});

test('source lookup names its loading requirement and enables Start change when discovery finishes', async () => {
  type Source = { configured: boolean; path: string | null };
  let resolveSource: ((value: Source) => void) | undefined;
  const source = new Promise<Source>(resolve => { resolveSource = resolve; });
  const f = await fixture({ routes: { '/api/improvements/source': () => source, '/api/improvements': () => ({ data: [] }) } });
  try {
    await f.page.evaluate(PNG => { (window as ImproveWindow).elpisDesktop.improve = { capture: async () => ({ image: PNG }) }; }, PNG);
    await f.page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const dialog = f.page.getByRole('dialog', { name: 'Improve Elpis' });
    await dialog.getByRole('textbox', { name: 'What should change?' }).fill('Keep this request while discovering source');
    await assertDialogActionsExplained(dialog, /Looking for.*Elpis source folder/);
    const resolve = resolveSource as ((value: Source) => void) | undefined; assert.ok(resolve); resolve({ configured: true, path: '/tmp/elpis-source' });
    await dialog.getByText('/tmp/elpis-source', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Start change' }).isEnabled(), true);
  } finally { const resolve = resolveSource as ((value: Source) => void) | undefined; assert.ok(resolve); resolve({ configured: false, path: null }); await f.close(); }
});

test('a source lookup error remains visible and names the folder requirement', async () => {
  const f = await fixture({ routes: { '/api/improvements/source': () => ({ __http: 500, error: 'Source discovery unavailable.' }), '/api/improvements': () => ({ data: [] }) } });
  try {
    await f.page.evaluate(PNG => { (window as ImproveWindow).elpisDesktop.improve = { capture: async () => ({ image: PNG }) }; }, PNG);
    await f.page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const dialog = f.page.getByRole('dialog', { name: 'Improve Elpis' });
    await dialog.getByRole('textbox', { name: 'What should change?' }).fill('Retain my request on error');
    await dialog.getByRole('alert').filter({ hasText: 'Source discovery unavailable.' }).waitFor();
    await assertDialogActionsExplained(dialog, /Choose.*Elpis source folder/);
  } finally { await f.close(); }
});
