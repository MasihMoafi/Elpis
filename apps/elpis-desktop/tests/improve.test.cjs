const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=';
const row = { id: 'change-1', branch: 'improve/20261018-button', cwd: '/tmp/change', status: 'review', head: 'abc', dirty: false, diff: 'diff --git a/button b/button\n--- a/button\n+++ b/button\n@@ -1 +1 @@\n-Send\n+Go', checks: null, thread: { id: 'chat-a' } };
const checkedRow = { ...row, checks: { passed: true, head: 'abc', commands: [{ command: 'node --test', code: 0, output: 'tests 1\npass 1' }] } };
async function setup(colorScheme = 'light', failCapture = false, result = checkedRow) {
  let started = false, current = row;
  const f = await fixture({ colorScheme, width: 1200, height: 800, routes: {
    '/api/improvements': body => { if (body) { started = true; return row; } return { data: started ? [{ id: row.id, threadId: 'chat-a' }] : [] }; },
    '/api/improvements/source': () => ({ configured: true, path: '/tmp/elpis-source' }),
    '/api/improvements/change-1': () => current,
    '/api/improvements/change-1/check': () => current = result,
    '/api/improvements/change-1/keep': () => ({ ...checkedRow, status: 'ready', note: '/tmp/ready.md' }),
  } });
  await f.page.evaluate(({ PNG, failCapture }) => { window.__captures = []; window.__tries = []; window.elpisDesktop.improve = { capture: async rect => { window.__captures.push(rect); if (failCapture) throw Error('Capture failed'); return { image: PNG }; }, try: async id => { window.__tries.push(id); return { opened: true }; } }; }, { PNG, failCapture });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  return f;
}
for (const colorScheme of ['light', 'dark']) test(`Ctrl+K improvement opens a pointed chat and review with measured tests, Try it and Keep (${colorScheme})`, async () => {
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
    assert.equal(sent.body.request, 'Rename Send to Go'); assert.equal(sent.body.target.image, PNG);
    assert.match(sent.body.target.id, /app\/page.tsx#Home/);
    const review = page.getByRole('dialog', { name: 'Review Elpis change' });
    await review.getByText('Run build and tests on this commit before trying or keeping it.', { exact: true }).waitFor();
    assert.equal(await review.getByRole('button', { name: 'Try it', exact: true }).isDisabled(), true);
    assert.equal(await review.getByRole('button', { name: 'Keep', exact: true }).isDisabled(), true);
    assert.ok(await review.getByText('Go', { exact: true }).count());
    if (process.env.ELPIS_IMPROVE_SHOTS) { await fs.mkdir(process.env.ELPIS_IMPROVE_SHOTS, { recursive: true }); await page.screenshot({ animations: 'disabled', path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `improve-${colorScheme}.png`) }); }
    const checkResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/improvements/change-1/check');
    await review.getByRole('button', { name: 'Check build & tests', exact: true }).click(); assert.equal((await checkResponse).ok(), true);
    await review.getByText('Build and tests passed', { exact: true }).waitFor();
    assert.equal(await review.getByRole('button', { name: 'Try it', exact: true }).isEnabled(), true);
    assert.equal(await review.getByRole('button', { name: 'Keep', exact: true }).isEnabled(), true);
    if (process.env.ELPIS_IMPROVE_SHOTS) await page.screenshot({ animations: 'disabled', path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `improve-passed-${colorScheme}.png`) });
    await review.getByRole('button', { name: 'Try it', exact: true }).click(); assert.deepEqual(await page.evaluate(() => window.__tries), ['change-1']);
    await review.getByRole('button', { name: 'Keep', exact: true }).click(); await review.getByText(/Ready for coordinator/).waitFor();
    assert.ok(f.posts.some(post => post.path === '/api/improvements/change-1/check'));
    assert.ok(f.posts.some(post => post.path === '/api/improvements/change-1/keep'));
    assert.ok(f.posts.every(post => !post.path.startsWith('/improvements/')));
    await review.getByRole('button', { name: 'Close', exact: true }).click();
    const overlap = await page.evaluate(() => { const a = document.querySelector('.elpis-improve-review-button').getBoundingClientRect(), b = document.querySelector('[aria-label="Show side panel"]').getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; });
    assert.equal(overlap, false, 'review action shares the header layout without covering the panel control');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
for (const colorScheme of ['light', 'dark']) test(`a failed check disables Try it and Keep and explains the failing check (${colorScheme})`, async () => {
  const failed = { ...row, status: 'checks-failed', checks: { passed: false, head: 'abc', commands: [{ command: 'npm run -s test:bridge', code: 1, output: 'Love Spot agent: SDK dependencies were not found; permission request never arrived.' }] } };
  const f = await setup(colorScheme, false, failed), { page } = f;
  try {
    await page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const request = page.getByRole('dialog', { name: 'Improve Elpis' });
    await request.getByRole('textbox', { name: 'What should change?' }).fill('Fix the review actions');
    await request.getByRole('button', { name: 'Start change' }).click();
    const review = page.getByRole('dialog', { name: 'Review Elpis change' });
    await review.getByRole('button', { name: 'Check build & tests' }).click();
    await review.getByRole('button', { name: 'Close', exact: true }).click({ trial: true });
    await review.getByText('Love Spot agent: SDK dependencies were not found; permission request never arrived.', { exact: true }).waitFor({ state: 'visible' });
    for (const name of ['Try it', 'Keep']) {
      const button = review.getByRole('button', { name, exact: true });
      assert.equal(await button.isDisabled(), true);
      assert.match(await button.getAttribute('title'), /npm run -s test:bridge.*exit 1/);
    }
    if (process.env.ELPIS_IMPROVE_SHOTS) {
      await fs.mkdir(process.env.ELPIS_IMPROVE_SHOTS, { recursive: true });
      await page.screenshot({ animations: 'disabled', path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `improve-failed-${colorScheme}.png`) });
    }
    assert.equal(f.posts.filter(post => post.path.endsWith('/keep')).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const [state, reason] of [
  [{ ...checkedRow, dirty: true }, /Commit this change/],
  [{ ...checkedRow, head: 'new-commit' }, /commit changed/],
  [{ ...checkedRow, status: 'checking', checks: null }, /Checking/],
]) test(`review actions explain why they are off: ${reason}`, async () => {
  const f = await setup('light', false, state), { page } = f;
  try {
    await page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const request = page.getByRole('dialog', { name: 'Improve Elpis' });
    await request.getByRole('textbox', { name: 'What should change?' }).fill('Review preconditions');
    await request.getByRole('button', { name: 'Start change' }).click();
    const review = page.getByRole('dialog', { name: 'Review Elpis change' });
    await review.getByRole('button', { name: 'Check build & tests' }).click();
    await review.getByRole('button', { name: 'Close', exact: true }).click({ trial: true });
    for (const name of ['Try it', 'Keep']) {
      const button = review.getByRole('button', { name, exact: true });
      assert.equal(await button.isDisabled(), true);
      assert.match(await button.getAttribute('title'), reason);
    }
    if (state.status === 'checking') assert.equal(await review.getByRole('button', { name: 'Check build & tests' }).isDisabled(), true);
  } finally { await f.close(); }
});

test('Try it requires the desktop preview method independently of Keep', async () => {
  const f = await setup(), { page } = f;
  try {
    await page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const request = page.getByRole('dialog', { name: 'Improve Elpis' });
    await request.getByRole('textbox', { name: 'What should change?' }).fill('Review without preview');
    await request.getByRole('button', { name: 'Start change' }).click();
    const review = page.getByRole('dialog', { name: 'Review Elpis change' });
    await page.evaluate(() => { delete window.elpisDesktop.improve.try; });
    await review.getByRole('button', { name: 'Check build & tests' }).click();
    await review.getByRole('button', { name: 'Close', exact: true }).click({ trial: true });
    const preview = review.getByRole('button', { name: 'Try it', exact: true });
    assert.equal(await preview.isDisabled(), true);
    assert.match(await preview.getAttribute('title'), /desktop app/);
    await review.getByText('Open the desktop app to try this change.', { exact: true }).waitFor();
    assert.equal(await review.getByRole('button', { name: 'Keep', exact: true }).isEnabled(), true);
  } finally { await f.close(); }
});
test('right-click preserves chat actions and carries the pointed component; capture failure blocks creation', async () => {
  const f = await setup('light', true), { page } = f;
  try {
    await page.locator('.thread-row[data-thread-id="chat-a"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: false }).waitFor();
    await page.getByRole('menuitem', { name: 'Change this…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Improve Elpis' });
    await dialog.getByText('Capture failed', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Start change' }).isEnabled(), false);
    assert.equal(f.posts.filter(post => post.path === '/api/improvements').length, 0);
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
    await f.page.evaluate(PNG => { window.elpisDesktop.improve = { capture: async () => ({ image: PNG }) }; window.elpisDesktop.chooseFolder = async () => '/tmp/wrong'; }, PNG);
    await f.page.evaluate(() => dispatchEvent(new Event('elpis:improve')));
    const dialog = f.page.getByRole('dialog', { name: 'Improve Elpis' }); await dialog.waitFor();
    const request = dialog.getByRole('textbox', { name: 'What should change?' }); await request.fill('Keep this requested change');
    assert.equal(await dialog.getByRole('button', { name: 'Start change' }).isDisabled(), true);
    await dialog.getByRole('button', { name: 'Choose source folder' }).click(); await dialog.getByRole('alert').waitFor();
    assert.equal(await request.inputValue(), 'Keep this requested change');
    await f.page.evaluate(() => { window.elpisDesktop.chooseFolder = async () => '/tmp/source'; });
    await dialog.getByRole('button', { name: 'Choose source folder' }).click();
    await dialog.getByText('/tmp/source', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: 'Start change' }).isEnabled(), true);
    assert.equal(f.posts.filter(p => p.path === '/api/improvements').length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
