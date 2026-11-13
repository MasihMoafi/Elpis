// D deletes a sidebar chat and Ctrl+Z brings it back, newest first, with its messages. Ctrl+Z in a text field stays
// the field's own undo. The exported UI against tests/parity-fixture.cts; the bridge's trash routes are faked here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cts');

const NAMES = { 'chat-a': 'Fix the parser', 'chat-b': 'Write the docs', 'chat-c': 'Plan the release' };
const chat = (id: keyof typeof NAMES) => ({ id, name: NAMES[id], preview: NAMES[id], cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
/** The bridge's trash, as the renderer sees it: one entry per deletion, Undo takes the newest. */
function trashRoutes() {
  const stack: (keyof typeof NAMES)[][] = [];
  return { stack, routes: {
    '/api/trash': (body: { threadIds: (keyof typeof NAMES)[] }) => { stack.push(body.threadIds); return { trashed: body.threadIds }; },
    '/api/trash/undo': () => ({ threads: (stack.pop() ?? []).map(chat) }),
  } };
}
const row = (page: { locator(selector: string): { first(): { locator(selector: string): { focus(): Promise<void> }; waitFor(options?: { state: string }): Promise<void>; count(): Promise<number> } } }, id: string) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`).first();
const trashPosts = (f: { posts: { path: string; body: { threadIds?: string[] } }[] }) => f.posts.filter(post => post.path.startsWith('/api/trash')).map(post => [post.path, post.body.threadIds ?? null]);

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
    await dialog.getByRole('checkbox', { name: 'Don’t show me this again' }).click();
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await row(page, 'chat-b').waitFor({ state: 'detached' });
    // Now D deletes at once, and the focus stays in the sidebar so Ctrl+Z still reaches the app.
    await f.open('chat-a');
    await row(page, 'chat-a').locator('.thread-link').focus();
    await page.keyboard.press('d');
    await row(page, 'chat-a').waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    // The app focuses a row one frame after the deleted row is gone (lib/chat-deletion.ts), so wait for it.
    await page.waitForFunction(() => !!document.activeElement?.closest('aside.sidebar'), undefined, { timeout: 5_000 })
      .catch(() => assert.fail('the focus stays in the sidebar after D'));
    await page.getByRole('status').filter({ hasText: 'Deleted “Fix the parser”' }).getByRole('button', { name: 'Undo' }).waitFor();
    assert.equal(f.posts.some((post: { path: string }) => /\/threads\/[^/]+\/delete$/.test(post.path)), false, 'nothing is deleted for good from the sidebar');

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

// Masih, 13 Nov: "the undo notif ... show below on top of the last message of any conversation". The Deleted notice sits at
// the sidebar's foot, or with the sidebar closed in the window's bottom left corner (the title bar when that corner would
// touch the chat): never over the transcript or the message box, at a wide and a narrow window.
test('the Deleted notice never covers the transcript or the message box, sidebar open or closed, wide or narrow', async () => {
  const { routes } = trashRoutes(), f = await fixture({ routes, width: 1440, height: 900 });
  const { page } = f;
  const box = (selector: string) => page.locator(selector).first().evaluate(element => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });
  const overlap = (a: { left: number; top: number; right: number; bottom: number }, b: typeof a) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const sidebarShown = () => page.locator('aside.sidebar').evaluate(element => getComputedStyle(element).display !== 'none');
  try {
    let asked = false;
    for (const [width, id] of [[1440, 'chat-c'], [720, 'chat-b']] as const) {
      await page.setViewportSize({ width, height: 900 });
      if (!(await sidebarShown())) await page.getByRole('button', { name: 'Open sidebar' }).first().click();
      await row(page, id).locator('.thread-link').focus();
      await page.keyboard.press('d');
      if (!asked) { await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click(); asked = true; }
      await row(page, id).waitFor({ state: 'detached' });
      const status = page.locator('.action-notices').getByRole('status').filter({ hasText: `Deleted “${NAMES[id]}”` });
      await status.waitFor();
      for (const open of [true, false]) {
        if (!open) {
          if (width > 760) await page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
          else await page.keyboard.press('Escape');
          await page.waitForFunction(() => getComputedStyle(document.querySelector('aside.sidebar')!).display === 'none');
        }
        if (!(await page.locator('.chat-scroll').first().isVisible())) await f.open('chat-a');
        const notice = await box('.action-notices'), transcript = await box('.chat-scroll'), composer = await box('.composer');
        const where = `${width} px, sidebar ${open ? 'open' : 'closed'}: ${JSON.stringify({ notice, transcript, composer })}`;
        assert.ok(notice.right > notice.left && notice.bottom > notice.top && notice.left >= 0 && notice.top >= 0 && notice.bottom <= 900, `the notice is on screen at ${where}`);
        // A narrow window's open sidebar is a drawer over the chat; the notice sits inside the drawer, above its footer.
        if (!(open && width <= 760)) {
          assert.equal(overlap(notice, transcript), false, `the notice stays off the transcript at ${where}`);
          assert.equal(overlap(notice, composer), false, `the notice stays off the message box at ${where}`);
        }
        if (open) { const side = await box('aside.sidebar'); assert.ok(notice.left >= side.left && notice.right <= side.right, `the notice sits in the sidebar column at ${where}`); }
        else if (width > 760) assert.ok(notice.left < 40 && notice.bottom > 800, `the notice sits in the bottom left corner at ${where}`);
      }
      // It stays reachable and still undoes.
      await status.getByRole('button', { name: 'Undo' }).click();
      await row(page, id).waitFor();
      if (width > 760) await page.getByRole('button', { name: 'Open sidebar' }).first().click();
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
