// A chat in its own worktree, as Claude's desktop app offers it ("Start with worktree"): the new chat's "Local" chip
// offers Worktree inside a Git repository; the chat shows its branch beside its folder and copies the name; archiving or
// deleting a chat whose worktree holds uncommitted work says where the worktree is kept; and a worktree chat is listed
// under its project. Local bridge fixture with real clicks; no engine, model or Git. ELPIS_SHOTS=<dir> saves screenshots.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { assertCollectionIcon } = require('./collection-icon-assertions.cjs');

const BRANCH = 'elpis/chat-1a2b3c', KEPT = `${CWD}-elpis/chats/chat-1a2b3c`;
const chat = (id, name, cwd = CWD) => ({ id, name, preview: name, cwd, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } });
const LISTED = [chat('chat-a', 'Fix the parser'), chat('chat-b', 'Write the docs'), chat('chat-c', 'Plan the release')];
const NEW = chat('chat-wt', 'Start the feature', KEPT);
const PROJECTS = { projects: [{ id: 'p1', name: 'parity-fixture', cwd: CWD }], selectedId: 'p1' };

/** The fixture with one project selected, a thread list that grows by the chats created, and `routes` on top. */
async function using({ repository = true, colorScheme = 'light', routes = {}, extra = [], running = false, storage = {} } = {}, run) {
  const created = [];
  const f = await fixture({ colorScheme, running, storage, routes: {
    '/api/repository': () => ({ repository }),
    '/api/threads': (body, url) => body ? (created.push(NEW), { thread: NEW, worktree: body.worktree ? { path: KEPT, branch: BRANCH } : undefined })
      : { data: url.searchParams.has('ancestorThreadId') || url.searchParams.get('archived') === 'true' ? [] : [...created, ...extra, ...LISTED], nextCursor: null },
    [`/api/threads/${NEW.id}`]: () => ({ thread: NEW, data: [], nextCursor: null }),
    [`/api/threads/${NEW.id}/resume`]: () => ({ thread: NEW, activeTurnId: null }),
    [`/api/threads/${NEW.id}/turns`]: () => ({ turn: { id: 't-wt' } }),
    [`/api/threads/${NEW.id}/git`]: (_, url) => url.searchParams.get('view') === 'branch' ? { branch: BRANCH } : {},
    ...routes,
  } });
  try {
    await f.page.evaluate(value => localStorage.setItem('elpis-projects-v1', JSON.stringify(value)), PROJECTS);
    await f.page.reload(); await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').first().waitFor();
    f.open = async id => {
      await f.page.locator(`.thread-row[data-thread-id="${id}"] .thread-link`).first().click();
      await f.page.locator(`.thread-row.active[data-thread-id="${id}"]`).first().waitFor();
    };
    await run(f);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}

test('an existing active chat can move its next turn to a new folder', () => {
  const target = '/tmp/active-chat-next-turn';
  const moved = [];
  const attachment = { id: 'folder-draft', name: 'keep-with-chat.txt', type: 'text', mimeType: 'text/plain', text: 'This file stays with the draft.' };
  return using({ running: true, storage: { 'elpis-attachments-v1:chat-a': JSON.stringify([attachment]) }, routes: {
    '/api/threads/chat-a/folder': body => { moved.push(body); return { cwd: body.cwd }; },
  } }, async f => {
    await f.open('chat-b');
    await f.open('chat-a');
    const composer = f.page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    const attachedFile = f.page.getByRole('button', { name: 'Remove keep-with-chat.txt', exact: true });
    await attachedFile.waitFor();
    await composer.fill('Keep this draft while the folder changes.');
    await f.page.evaluate(cwd => { window.elpisDesktop.chooseFolder = async () => cwd; }, target);
    const change = f.page.getByRole('button', { name: 'Change folder', exact: true });
    assert.equal(await change.isEnabled(), true, 'the folder control stays available during a running turn');
    await change.click();
    await f.page.getByRole('menuitem', { name: 'Choose folder…', exact: true }).click();
    await f.page.waitForFunction(cwd => document.querySelector('[aria-label="Change folder"]')?.getAttribute('title') === cwd, target);
    await f.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await attachedFile.waitFor();
    assert.equal(await composer.inputValue(), 'Keep this draft while the folder changes.');
    await f.page.getByText('All green.', { exact: true }).waitFor();
    assert.deepEqual(moved, [{ cwd: target }]);
  });
});
const shoot = async (page, name) => {
  if (!process.env.ELPIS_SHOTS) return;
  await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `${name}.png`) });
};
const where = page => page.getByRole('button', { name: 'Where this chat works' });
const branchChip = page => page.getByRole('button', { name: `Branch ${BRANCH}` });

for (const colorScheme of ['light', 'dark']) test(`a new chat can start in its own worktree: Worktree in the Local menu, then the first message (${colorScheme})`, () => using({ colorScheme }, async f => {
  const { page, composer } = f;
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  // New chats start in no project (TASKS.md:111), so choose the repository's project first.
  await page.getByRole('button', { name: 'Choose project', exact: true }).click();
  await page.getByRole('menuitem', { name: /parity-fixture/ }).click();
  await where(page).click();
  const worktree = page.getByRole('menuitem', { name: /^Worktree/ });
  await worktree.waitFor(); await shoot(page, `worktree-menu-${colorScheme}`);
  await assertCollectionIcon(worktree.locator('svg').first(), 'branch', 'Worktree location option');
  assert.equal(await worktree.getAttribute('aria-disabled'), null, 'offered inside a Git repository with a commit');
  await worktree.click();
  assert.match(await where(page).innerText(), /Worktree/, 'the chip says where the chat will work');
  await composer.fill('Start the feature'); await composer.press('Enter');
  const start = await (async () => { for (let i = 0; i < 80; i++) { const post = f.posts.find(item => item.path === '/api/threads'); if (post) return post; await page.waitForTimeout(50); } })();
  assert.ok(start, 'the chat was created');
  assert.equal(start.body.worktree, true); assert.equal(start.body.cwd, CWD);
  await branchChip(page).waitFor();
  assert.equal(await branchChip(page).innerText(), BRANCH, 'the new chat shows its branch');
  await shoot(page, `worktree-chat-${colorScheme}`);
}));

test('outside a Git repository with a commit, Worktree is offered but cannot be chosen, and says why', () => using({ repository: false }, async f => {
  const { page, composer } = f;
  await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
  await where(page).click();
  const worktree = page.getByRole('menuitem', { name: /^Worktree/ });
  await worktree.waitFor();
  assert.equal(await worktree.getAttribute('aria-disabled'), 'true');
  assert.match(await worktree.innerText(), /Git repository with a commit/);
  await page.keyboard.press('Escape');
  await composer.fill('Plain chat'); await composer.press('Enter');
  for (let i = 0; i < 80 && !f.posts.some(item => item.path === '/api/threads'); i++) await page.waitForTimeout(50);
  assert.equal(f.posts.find(item => item.path === '/api/threads').body.worktree, undefined, 'the chat works in the folder itself');
}));

test('a chat shows the branch it is on beside its folder; the chip copies the name', () => using({ routes: {
  '/api/threads/chat-a/git': (_, url) => url.searchParams.get('view') === 'branch' ? { branch: BRANCH } : {},
  '/api/threads/chat-b/git': (_, url) => url.searchParams.get('view') === 'branch' ? { branch: null } : {},
} }, async f => {
  const { page } = f;
  await f.open('chat-a');
  await branchChip(page).waitFor();
  assert.equal(await branchChip(page).getAttribute('title'), BRANCH);
  await branchChip(page).click();
  await page.getByRole('menuitem', { name: 'Copy branch name' }).click();
  assert.equal(await f.copied(), BRANCH);
  await page.getByText('Branch name copied to clipboard.').waitFor();
  await f.open('chat-b');
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.branch-chip').count(), 0, 'no branch, no chip');
}));

test('opening a chat with an active turn still loads its branch', () => using({ routes: {
  '/api/threads/chat-a/resume': () => ({ thread: LISTED[0], activeTurnId: 't4' }),
  '/api/threads/chat-a/git': async (_, url) => {
    if (url.searchParams.get('view') !== 'branch') return {};
    await new Promise(resolve => setTimeout(resolve, 150));
    return { branch: BRANCH };
  },
} }, async f => {
  await f.open('chat-a');
  await branchChip(f.page).waitFor();
  assert.equal(await branchChip(f.page).innerText(), BRANCH);
}));

for (const colorScheme of ['light', 'dark']) test(`archiving or deleting a chat whose worktree has uncommitted work says where the worktree is kept (${colorScheme})`, () => using({ colorScheme, routes: {
  '/api/threads/chat-a/archive': () => ({ archived: true, worktree: { kept: true, path: KEPT, branch: BRANCH, changes: 2 } }),
  '/api/trash': () => ({ trashed: ['chat-b'], worktrees: [{ threadId: 'chat-b', worktree: { kept: true, path: `${KEPT}0`, branch: `${BRANCH}0`, changes: 1 } }] }),
  '/api/threads/chat-c/archive': () => ({ archived: true, worktree: { removed: true, path: KEPT, branch: BRANCH } }),
} }, async f => {
  const { page } = f;
  const row = id => page.locator(`.recents .thread-row[data-thread-id="${id}"], section[aria-label="Recents"] .thread-row[data-thread-id="${id}"]`).first();
  // The row's hover Archive button is gone (577d5a5ad; Masih, 27 Oct: "it moves when I hover over it", "this thing showing all
  // of these is very ugly"); Archive and Delete are in the row's "…" menu.
  const act = async (id, name, item) => { await row(id).hover(); await row(id).getByRole('button', { name: `Actions for ${name}` }).click(); await page.getByRole('menuitem', { name: item }).click(); };
  await act('chat-a', 'Fix the parser', /^Archive/);
  const notice = page.locator('.worktree-notice');
  await notice.waitFor();
  assert.equal(await notice.innerText(), `“Fix the parser” was archived with 2 uncommitted changes. Its worktree is still on disk at ${KEPT} (branch ${BRANCH}). Unarchive the chat to keep working in it.`);
  await shoot(page, `worktree-kept-${colorScheme}`);
  await page.getByRole('button', { name: 'Dismiss worktree notice' }).click();
  await notice.waitFor({ state: 'detached' });
  await act('chat-b', 'Write the docs', /^Delete/);
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await notice.waitFor();
  assert.equal(await notice.innerText(), `“Write the docs” was deleted. Its worktree has 1 uncommitted change, so it is still on disk at ${KEPT}0 (branch ${BRANCH}0).`);
  await page.getByRole('button', { name: 'Dismiss worktree notice' }).click();
  await act('chat-c', 'Plan the release', /^Archive/);
  await row('chat-c').waitFor({ state: 'detached' });
  assert.equal(await notice.count(), 0, 'a clean worktree goes without a word');
}));

// Membership is explicit (TASKS.md:111): a chat's folder, even a worktree of a project, does not put it in that project.
test('a chat working in a worktree of a project stays out of that project until it is moved there', () => using({ extra: [chat('chat-in-wt', 'Feature in a worktree', KEPT)] }, async f => {
  await f.page.locator('.thread-row[data-thread-id="chat-in-wt"]').waitFor();
  const group = f.page.locator('.project-group').filter({ hasText: 'parity-fixture' });
  assert.equal(await group.locator('.thread-row[data-thread-id="chat-in-wt"]').count(), 0, 'no folder-based project membership');
}));
