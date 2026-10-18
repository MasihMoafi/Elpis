const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=';
const row = { id: 'change-1', branch: 'improve/20261018-button', cwd: '/tmp/change', status: 'review', head: 'abc', dirty: false, diff: 'diff --git a/button b/button\n--- a/button\n+++ b/button\n@@ -1 +1 @@\n-Send\n+Go', checks: { passed: true, head: 'abc', commands: [{ command: 'node --test', code: 0, output: 'tests 1\npass 1' }] }, thread: { id: 'chat-a' } };
async function setup(colorScheme = 'light', failCapture = false) {
  let started = false;
  const f = await fixture({ colorScheme, width: 1200, height: 800, routes: {
    '/api/improvements': body => { if (body) { started = true; return row; } return { data: started ? [{ id: row.id, threadId: 'chat-a' }] : [] }; },
    '/api/improvements/change-1': () => row,
    '/api/improvements/change-1/check': () => row,
    '/api/improvements/change-1/keep': () => ({ ...row, status: 'ready', note: '/tmp/ready.md' }),
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
    if (process.env.ELPIS_IMPROVE_SHOTS) { await fs.mkdir(process.env.ELPIS_IMPROVE_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `improve-request-${colorScheme}.png`) }); }
    await dialog.getByRole('textbox', { name: 'What should change?' }).fill('Rename Send to Go');
    await dialog.getByRole('button', { name: 'Start change' }).click();
    await dialog.waitFor({ state: 'detached' });
    const sent = f.posts.find(post => post.path === '/api/improvements');
    assert.equal(sent.body.request, 'Rename Send to Go'); assert.equal(sent.body.target.image, PNG);
    assert.match(sent.body.target.id, /app\/page.tsx#Home/);
    const review = page.getByRole('dialog', { name: 'Review Elpis change' }); await review.getByText('Build and tests passed', { exact: true }).waitFor();
    assert.ok(await review.getByText('Go', { exact: true }).count());
    if (process.env.ELPIS_IMPROVE_SHOTS) { await fs.mkdir(process.env.ELPIS_IMPROVE_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.ELPIS_IMPROVE_SHOTS, `improve-${colorScheme}.png`) }); }
    await review.getByRole('button', { name: 'Try it', exact: true }).click(); assert.deepEqual(await page.evaluate(() => window.__tries), ['change-1']);
    await review.getByRole('button', { name: 'Keep', exact: true }).click(); await review.getByText(/Ready for coordinator/).waitFor();
    await review.getByRole('button', { name: 'Close', exact: true }).click();
    const overlap = await page.evaluate(() => { const a = document.querySelector('.elpis-improve-review-button').getBoundingClientRect(), b = document.querySelector('[aria-label="Show side panel"]').getBoundingClientRect(); return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; });
    assert.equal(overlap, false, 'review action shares the header layout without covering the panel control');
    assert.deepEqual(f.errors, []);
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
