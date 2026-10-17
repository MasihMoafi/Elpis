// What the agent looked at and made, as Claude's chats show it: an image it viewed is a thumbnail on the folded
// activity row and in the step itself, and each file it created is a card after the reply that opens the file.
// Local bridge fixture (tests/parity-fixture.cjs); no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const WORK = [
  { id: 'view-1', type: 'imageView', path: `${CWD}/shots/home.png` },
  { id: 'edit-1', type: 'fileChange', status: 'completed', changes: [
    { path: `${CWD}/report.html`, kind: { type: 'add' }, diff: '<h1>Report</h1>\n' },
    { path: `${CWD}/src/app.ts`, kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] },
];

test('a viewed image is a thumbnail on its folded row and in its step; a created file is a card that opens it', async () => {
  const f = await fixture({ chat: [['t1', 'Make the report.', 'The report is ready.', WORK]] });
  try {
    const { page } = f;
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await page.getByText('The report is ready.', { exact: true }).waitFor();
    await page.evaluate(() => { window.elpisDesktop.openFile = async target => { window.__opened = target; }; window.elpisDesktop.openFolder = async target => { window.__folder = target; }; });
    // The work folds into "Worked for …"; opened, its row names the image and shows it.
    await page.locator('.worked-for > summary').click();
    const row = page.locator('.activity-group > summary').first();
    assert.match(await row.innerText(), /Viewed an image/);
    const thumb = row.locator('img.activity-thumb');
    assert.equal(await thumb.count(), 1, 'the folded row shows the image');
    await page.waitForFunction(() => document.querySelector('.activity-group > summary img.activity-thumb')?.naturalWidth > 0);
    assert.match(await thumb.getAttribute('src'), /\/api\/threads\/chat-a\/turns\/t1\/items\/view-1\/media\/0$/);
    assert.equal(await thumb.getAttribute('alt'), 'home.png');
    // Opened, the step shows it larger, named.
    await row.click();
    const step = page.locator('.activity-group-body').getByRole('img', { name: 'home.png', exact: true });
    await step.waitFor();
    // A click on the thumbnail shows the picture full size; Esc closes it.
    await row.locator('img.activity-thumb').click();
    const full = page.getByRole('dialog', { name: 'home.png', exact: true });
    await full.waitFor();
    await page.keyboard.press('Escape');
    await full.waitFor({ state: 'hidden' });
    // The created file is a card after the reply, as Claude's: its name, its kind and extension, Open and Show in
    // folder; the edited file gets none.
    const cards = page.getByRole('list', { name: 'Files created', exact: true });
    assert.equal(await cards.getByRole('listitem').count(), 1);
    assert.equal(await cards.locator('.file-card-name').innerText(), 'report');
    assert.equal(await cards.locator('.file-card-type').innerText(), 'Code · HTML');
    await cards.getByRole('button', { name: 'Open report.html', exact: true }).click();
    await page.getByRole('tab', { name: 'report.html', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__opened), undefined);
    await cards.getByRole('button', { name: 'Show report.html in folder', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__folder), CWD);
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/chat-files.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
