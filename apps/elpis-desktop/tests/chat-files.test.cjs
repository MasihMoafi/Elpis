// What the agent looked at and made, as Claude's chats show it: an image it viewed is a thumbnail on the folded
// activity row and in the step itself, and each file it created is a card after the reply that opens the file (an HTML
// file as a page in the chat's browser).
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

test('a viewed image is a thumbnail on its folded row and in its step; a created file is a card that opens it, HTML in the browser', async () => {
  const PAGE = `http://127.0.0.1:4999/${'a'.repeat(32)}/report.html`;
  const f = await fixture({ chat: [['t1', 'Make the report.', 'The report is ready.', WORK]], routes: { '/api/dev-servers/page': () => ({ url: PAGE }) } });
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
    await page.waitForFunction(url => window.__commands?.some(command => command.action === 'new' && command.url === url), PAGE);
    assert.deepEqual(f.posts.find(post => post.path === '/api/dev-servers/page').body, { cwd: CWD, path: 'report.html' });
    assert.equal(await page.evaluate(() => window.__opened), undefined, 'not handed to another app');
    await cards.getByRole('button', { name: 'Show report.html in folder', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__folder), CWD);
    if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/chat-files.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('a created document can be marked or given an edit/removal request without sending unfinished text', async () => {
  const f = await fixture({ chat: [['t1', 'Make a report.', 'The report is ready.', WORK]] });
  try {
    const { page } = f;
    await f.open('chat-a');
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await input.fill('Keep this unfinished question.');
    await page.getByRole('button', { name: 'More actions for report.html', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Mark for agent', exact: true }).click();
    const review = page.getByRole('alertdialog', { name: 'Document feedback', exact: true });
    await review.getByRole('textbox', { name: 'Selected passage', exact: true }).fill('The cited evidence is incomplete.');
    await review.getByRole('textbox', { name: 'Instructions for the agent', exact: true }).fill('Replace this conclusion after checking the sources.');
    await review.getByRole('button', { name: 'Add to message', exact: true }).click();
    await review.waitFor({ state: 'hidden' });
    assert.equal(await input.inputValue(), 'Keep this unfinished question.');
    await page.getByText('Feedback on report.html', { exact: true }).waitFor();
    assert.equal(f.posts.some(post => /\/turns$/.test(post.path)), false, 'feedback never sends an unfinished composer');
    await page.getByRole('button', { name: 'More actions for report.html', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Ask agent to remove', exact: true }).click();
    await review.getByRole('textbox', { name: 'Instructions for the agent', exact: true }).waitFor();
    assert.match(await review.getByRole('textbox', { name: 'Instructions for the agent', exact: true }).inputValue(), /remove/i);
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Open report.html', exact: true }).count(), 1, 'a suggestion does not delete the document');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
