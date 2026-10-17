// D deletes a sidebar chat and Ctrl+Z brings it back, newest first, with its messages. Ctrl+Z in a text field stays
// the field's own undo. The exported UI against tests/parity-fixture.cjs; the bridge's trash routes are faked here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const NAMES = { 'chat-a': 'Fix the parser', 'chat-b': 'Write the docs', 'chat-c': 'Plan the release' };
const chat = id => ({ id, name: NAMES[id], preview: NAMES[id], cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
/** The bridge's trash, as the renderer sees it: one entry per deletion, Undo takes the newest. */
function trashRoutes() {
  const stack = [];
  return { stack, routes: {
    '/api/trash': body => { stack.push(body.threadIds); return { trashed: body.threadIds }; },
    '/api/trash/undo': () => ({ threads: (stack.pop() ?? []).map(chat) }),
  } };
}
const row = (page, id) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`).first();
const trashPosts = f => f.posts.filter(post => post.path.startsWith('/api/trash')).map(post => [post.path, post.body.threadIds ?? null]);

test('D deletes the focused chat and Ctrl+Z brings back the last deleted chats one deletion at a time', async () => {
  const { stack, routes } = trashRoutes(), f = await fixture({ routes });
  const { page } = f;
  try {
    // The first deletion asks, says Ctrl+Z undoes it, and offers to stop asking.
    await row(page, 'chat-b').locator('.thread-link').focus();
    await page.keyboard.press('d');
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText(/Ctrl\+Z brings it back/).waitFor();
    assert.equal(await dialog.getByText('This cannot be undone').count(), 0);
    await dialog.getByLabel('Don’t show me this again').check();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await row(page, 'chat-b').waitFor({ state: 'detached' });
    // Now D deletes at once, and the focus stays in the sidebar so Ctrl+Z still reaches the app.
    await f.open('chat-a');
    await row(page, 'chat-a').locator('.thread-link').focus();
    await page.keyboard.press('d');
    await row(page, 'chat-a').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest('aside.sidebar')), 'the focus stays in the sidebar after D');
    await page.getByRole('status').filter({ hasText: 'Deleted “Fix the parser”' }).getByRole('button', { name: 'Undo' }).waitFor();
    assert.equal(f.posts.some(post => /\/threads\/[^/]+\/delete$/.test(post.path)), false, 'nothing is deleted for good from the sidebar');

    await page.keyboard.press('Control+z');
    await row(page, 'chat-a').waitFor();
    // The chat that was open comes back open, with its messages.
    await page.locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
    await page.getByText('All green.', { exact: true }).waitFor();
    assert.equal(await row(page, 'chat-b').count(), 0, 'one Ctrl+Z undoes one deletion');
    await page.locator('body').click({ position: { x: 600, y: 5 } });
    await page.keyboard.press('Control+z');
    await row(page, 'chat-b').waitFor();
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    assert.deepEqual(trashPosts(f), [['/api/trash', ['chat-b']], ['/api/trash', ['chat-a']], ['/api/trash/undo', null], ['/api/trash/undo', null], ['/api/trash/undo', null]]);
    assert.equal(stack.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the notice’s Undo brings the chat back; Ctrl+Z in the message box undoes typing, not a deletion', async () => {
  const { routes } = trashRoutes(), f = await fixture({ routes });
  const { page, composer } = f;
  try {
    await row(page, 'chat-c').locator('.thread-link').focus();
    await page.keyboard.press('d');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await row(page, 'chat-c').waitFor({ state: 'detached' });
    await composer.click();
    await page.keyboard.type('hello');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    assert.notEqual(await composer.inputValue(), 'hello', 'Ctrl+Z undid the typing');
    assert.equal(await row(page, 'chat-c').count(), 0);
    assert.equal(trashPosts(f).some(([path]) => path === '/api/trash/undo'), false, 'Ctrl+Z in a text field never brings back a chat');
    await page.getByRole('status').filter({ hasText: 'Deleted “Plan the release”' }).getByRole('button', { name: 'Undo' }).click();
    await row(page, 'chat-c').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
