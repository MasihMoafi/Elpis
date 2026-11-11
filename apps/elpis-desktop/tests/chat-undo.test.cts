// Shared system, requirement 4 (production row S5): outside a text field Ctrl+Z undoes the last chat action (rename,
// move into or out of a project, archive, delete) and Ctrl+Shift+Z does it again; in a text field both stay the field's
// own. The exported UI against tests/parity-fixture.cts, with a bridge that keeps names, archive state and the trash.
import type { Page } from 'playwright-core';
type Post = { path: string; body: { name?: string; threadIds?: string[] } };
type Fixture = { page: Page; composer: ReturnType<Page['getByRole']>; posts: Post[]; errors: string[]; close(): Promise<void> };
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD }: { fixture(options: object): Promise<Fixture>; CWD: string } = require('./parity-fixture.cts');
const { threadMenuItem } = require('./controls.cts');

const PROJECT = { id: 'docs', name: 'Docs project', cwd: '/tmp/docs-project' };
/** The bridge as the renderer sees it: renames stick, archived chats leave the list, the trash brings back the newest. */
function bridge() {
  const names: Record<string, string> = { 'chat-a': 'Fix the parser', 'chat-b': 'Write the docs', 'chat-c': 'Plan the release' };
  const archived = new Set<string>(), trash: string[][] = [];
  const chat = (id: string) => ({ id, name: names[id], preview: names[id], cwd: CWD, model: 'sol', modelProvider: 'openai',
    status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
  const gone = (id: string) => archived.has(id) || trash.some(entry => entry.includes(id));
  const routes: Record<string, (body: { name?: string; threadIds?: string[] }, url: URL) => unknown> = {
    '/api/threads': (_body, url) => ({
      data: url.searchParams.has('ancestorThreadId') ? [] : url.searchParams.get('archived') === 'true'
        ? [...archived].map(chat) : Object.keys(names).filter(id => !gone(id)).map(chat),
      nextCursor: null,
    }),
    '/api/trash': body => { trash.push(body.threadIds ?? []); return { trashed: body.threadIds }; },
    '/api/trash/undo': () => ({ threads: (trash.pop() ?? []).map(chat) }),
  };
  for (const id of Object.keys(names)) {
    routes[`/api/threads/${id}/rename`] = body => { names[id] = body.name ?? ''; return { thread: chat(id) }; };
    routes[`/api/threads/${id}/archive`] = () => { archived.add(id); return { archived: true }; };
    routes[`/api/threads/${id}/unarchive`] = () => { archived.delete(id); return { thread: chat(id) }; };
  }
  return { names, archived, routes };
}
async function open() {
  const state = bridge();
  const storage = { 'elpis-projects-v1': JSON.stringify({ projects: [PROJECT], selectedId: null }) };
  return { ...state, f: await fixture({ routes: state.routes, storage }) };
}
const row = (page: Page, id: string) => page.locator(`aside.sidebar .thread-row[data-thread-id="${id}"]`).first();
const nameOf = (page: Page, id: string) => row(page, id).locator('.thread-link').innerText().then(text => text.split('\n')[0]);
/** The page holds the focus, as after a click on an empty part of the window. */
const focusPage = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
const notice = (page: Page, text: string) => page.locator('.workspace-notices [role="status"]').filter({ hasText: text });
const posted = (f: Fixture, pattern: RegExp) => f.posts.filter(post => pattern.test(post.path)).map(post => post.path);
async function eventually(check: () => Promise<unknown>) {
  const end = Date.now() + 5000;
  for (;;) {
    try { return await check(); } catch (error) { if (Date.now() > end) throw error; await new Promise(resolve => setTimeout(resolve, 50)); }
  }
}
async function rename(page: Page, id: string, name: string) {
  await row(page, id).locator('.thread-link').focus();
  await page.keyboard.press('F2');
  const field = page.getByRole('alertdialog').getByLabel('Conversation name');
  await field.fill(name);
  await page.keyboard.press('Enter');
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
}
async function action(page: Page, id: string, name: string) {
  await row(page, id).hover();
  await row(page, id).getByRole('button', { name: /^Actions for / }).click();
  await (await threadMenuItem(page, name)).click();
}

test('Ctrl+Z puts a renamed chat’s old name back and Ctrl+Shift+Z the new one, with a line saying so', async () => {
  const { f, names } = await open();
  const { page } = f;
  try {
    await rename(page, 'chat-b', 'Docs, second draft');
    await eventually(async () => assert.equal(await nameOf(page, 'chat-b'), 'Docs, second draft'));
    await focusPage(page);
    await page.keyboard.press('Control+z');
    await eventually(async () => assert.equal(await nameOf(page, 'chat-b'), 'Write the docs'));
    assert.equal(names['chat-b'], 'Write the docs', 'the bridge has the old name again');
    await notice(page, 'Undone: renamed “Write the docs” to “Docs, second draft”').waitFor();
    await page.keyboard.press('Control+Shift+z');
    await eventually(async () => assert.equal(await nameOf(page, 'chat-b'), 'Docs, second draft'));
    await notice(page, 'Redone: renamed “Write the docs” to “Docs, second draft”').waitFor();
    assert.equal(names['chat-b'], 'Docs, second draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Ctrl+Z takes a chat moved into a project back to Recents; Ctrl+Shift+Z moves it in again', async () => {
  const { f } = await open();
  const { page } = f;
  const inProject = page.locator('aside.sidebar .project-group').filter({ has: page.getByRole('button', { name: PROJECT.name, exact: true }) });
  const recents = page.locator('aside.sidebar section[aria-label="Recents"]');
  try {
    await action(page, 'chat-b', 'Move to project…');
    await page.getByRole('alertdialog', { name: 'Move chat to project' }).getByRole('button', { name: PROJECT.name, exact: true }).click();
    await inProject.locator('.thread-row[data-thread-id="chat-b"]').waitFor();
    await focusPage(page);
    await page.keyboard.press('Control+z');
    await recents.locator('.thread-row[data-thread-id="chat-b"]').waitFor();
    assert.equal(await inProject.locator('.thread-row[data-thread-id="chat-b"]').count(), 0, 'the chat left the project');
    await notice(page, 'Undone: moved “Write the docs” to Docs project').waitFor();
    await page.keyboard.press('Control+Shift+z');
    await inProject.locator('.thread-row[data-thread-id="chat-b"]').waitFor();
    assert.equal(await recents.locator('.thread-row[data-thread-id="chat-b"]').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Ctrl+Z unarchives an archived chat and Ctrl+Shift+Z archives it again', async () => {
  const { f, archived } = await open();
  const { page } = f;
  try {
    await action(page, 'chat-b', 'Archive');
    await row(page, 'chat-b').waitFor({ state: 'detached' });
    await focusPage(page);
    await page.keyboard.press('Control+z');
    await row(page, 'chat-b').waitFor();
    assert.equal(archived.has('chat-b'), false);
    await notice(page, 'Undone: archived “Write the docs”').waitFor();
    await page.keyboard.press('Control+Shift+z');
    await row(page, 'chat-b').waitFor({ state: 'detached' });
    assert.equal(archived.has('chat-b'), true);
    assert.deepEqual(posted(f, /\/(un)?archive$/), ['/api/threads/chat-b/archive', '/api/threads/chat-b/unarchive', '/api/threads/chat-b/archive']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Ctrl+Shift+Z deletes again a chat Ctrl+Z brought back', async () => {
  const { f } = await open();
  const { page } = f;
  try {
    await row(page, 'chat-c').locator('.thread-link').focus();
    await page.keyboard.press('d');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await row(page, 'chat-c').waitFor({ state: 'detached' });
    await focusPage(page);
    await page.keyboard.press('Control+z');
    await row(page, 'chat-c').waitFor();
    await page.keyboard.press('Control+Shift+z');
    await row(page, 'chat-c').waitFor({ state: 'detached' });
    assert.deepEqual(posted(f, /^\/api\/trash/), ['/api/trash', '/api/trash/undo', '/api/trash']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('in the message box Ctrl+Z and Ctrl+Shift+Z undo and redo the typing, never a chat action', async () => {
  const { f, names } = await open();
  const { page, composer } = f;
  try {
    await rename(page, 'chat-b', 'Docs, second draft');
    await eventually(async () => assert.equal(await nameOf(page, 'chat-b'), 'Docs, second draft'));
    await composer.click();
    await page.keyboard.type('hello');
    await page.keyboard.press('Control+z');
    await eventually(async () => assert.notEqual(await composer.inputValue(), 'hello', 'Ctrl+Z undid the typing'));
    await page.keyboard.press('Control+Shift+z');
    await eventually(async () => assert.equal(await composer.inputValue(), 'hello', 'Ctrl+Shift+Z redid the typing'));
    await page.waitForTimeout(300);
    assert.equal(await nameOf(page, 'chat-b'), 'Docs, second draft', 'the chat keeps its new name');
    assert.equal(names['chat-b'], 'Docs, second draft');
    assert.equal(posted(f, /\/rename$/).length, 1, 'only the one rename reached the bridge');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
