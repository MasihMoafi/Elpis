import type { fixture as Fixture } from './parity-fixture.cts';
import type { Page } from 'playwright-core';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { fixture }: { fixture: typeof Fixture } = require('./parity-fixture.cts');

test('clicking Organize moves a recent chat to an existing project and back', async () => {
  const staticDir = process.env.ELPIS_STATUS_STATIC_DIR;
  const storage = { 'elpis-projects-v1': JSON.stringify({ projects: [
    { id: 'elpis', name: 'elpis', cwd: '/work/elpis' },
    { id: 'rag', name: 'rag', cwd: '/work/rag' },
    { id: 'uni', name: 'uni', cwd: '/work/uni' },
  ], selectedId: null }) };
  const f = await fixture({ ...(staticDir ? { staticDir } : {}), storage });
  const page = f.page as unknown as Page;
  const recents = page.locator('aside.sidebar section[aria-label="Recents"]');
  const project = page.locator('aside.sidebar').getByRole('group', { name: 'rag', exact: true });
  const row = () => page.locator('aside.sidebar [data-thread-id="chat-a"]').first();
  async function picker() {
    await row().hover();
    await row().getByRole('button', { name: 'Actions for Fix the parser' }).click();
    await page.getByRole('menuitem', { name: 'Organize', exact: true }).click();
    const submenu = page.getByRole('menu', { name: 'Organize', exact: true });
    await submenu.waitFor({ timeout: 2000 });
    await submenu.getByRole('menuitem', { name: 'Move to project…', exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Move chat to project' });
    await dialog.waitFor();
    return dialog;
  }
  try {
    await recents.locator('[data-thread-id="chat-a"]').waitFor();
    let dialog = await picker();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await recents.locator('[data-thread-id="chat-a"]').count(), 1, 'cancelling leaves the chat in Recents');
    dialog = await picker();
    await dialog.getByRole('button', { name: 'rag', exact: true }).click();
    await project.locator('[data-thread-id="chat-a"]').waitFor();
    assert.equal(await recents.locator('[data-thread-id="chat-a"]').count(), 0);
    await page.reload();
    await project.locator('[data-thread-id="chat-a"]').waitFor();
    dialog = await picker();
    await dialog.getByRole('button', { name: 'No project', exact: true }).click();
    await recents.locator('[data-thread-id="chat-a"]').waitFor();
    assert.equal(await project.locator('[data-thread-id="chat-a"]').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
