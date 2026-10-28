// Masih, 23 Oct: "we should add the import chats options like cloudroom does." Settings → Import chats lists Claude Code and Codex with their chats, imports on press, says what happened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

test('Import chats offers Claude Code and Codex with their chats, imports on press, reports the result and refreshes the list', async () => {
  let chats = 60, codex = 3;
  const posts = [];
  const f = await fixture({ routes: { '/api/import-chats': body => {
    if (!body) return { days: 30, atATime: 50, sources: [{ id: 'claude-code', name: 'Claude Code', chats }, { id: 'codex', name: 'Codex', chats: codex }] };
    posts.push(body);
    if (body.source === 'codex') { codex = 0; return { imported: 3, skipped: [] }; }
    chats -= 50; return { imported: 49, skipped: ['This chat is empty.'] };
  } } });
  try {
    const { page } = f; page.setDefaultTimeout(7000);
    await openSettings(page); await page.getByRole('tab', { name: 'Import chats', exact: true }).click();
    const panel = page.getByRole('tabpanel');
    await panel.getByText('Bring your Claude Code and Codex chats over as Elpis chats.', { exact: false }).waitFor();
    await panel.getByText('60 chats from the last 30 days; 50 at a time.').waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Import Claude Code chats' }).textContent(), 'Import 50', 'one press imports at most 50');
    await panel.getByRole('button', { name: 'Import Claude Code chats' }).click();
    await panel.getByText('Imported 49 chats from Claude Code. 1 skipped: This chat is empty.').waitFor();
    assert.deepEqual(posts, [{ source: 'claude-code' }]);
    await panel.getByText('10 chats from the last 30 days.').waitFor();
    await panel.getByText('3 chats from the last 30 days.').waitFor();
    await panel.getByRole('button', { name: 'Import Codex chats' }).click();
    await panel.getByText('Imported 3 chats from Codex.').waitFor();
    assert.deepEqual(posts, [{ source: 'claude-code' }, { source: 'codex' }]);
    await panel.getByText('No chats from the last 30 days.').waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Import Codex chats' }).isDisabled(), true, 'Codex stays in the list, with nothing left to import');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('with nothing to import both apps are still there and say so', async () => {
  const f = await fixture({ routes: { '/api/import-chats': () => ({ days: 30, atATime: 50, sources: [{ id: 'claude-code', name: 'Claude Code', chats: 0 }, { id: 'codex', name: 'Codex', chats: 0 }] }) } });
  try {
    await openSettings(f.page); await f.page.getByRole('tab', { name: 'Import chats', exact: true }).click();
    const panel = f.page.getByRole('tabpanel');
    await panel.getByText('No chats from the last 30 days.').first().waitFor();
    assert.equal(await panel.getByText('No chats from the last 30 days.').count(), 2, 'one line for each app');
    for (const name of ['Import Claude Code chats', 'Import Codex chats']) assert.equal(await panel.getByRole('button', { name }).isDisabled(), true, name);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Live check, 28 Oct: chats that arrived while the window was open (or an import made elsewhere) left the old counts in place;
// switching tabs or leaving Settings kept them, and only a reload showed the new ones.
test('the counts are read again each time Import chats is shown, not only when the window loads', async () => {
  let chats = 0, reads = 0;
  const f = await fixture({ routes: { '/api/import-chats': body => {
    if (body) return { imported: 0, skipped: [] };
    reads++; return { days: 30, atATime: 50, sources: [{ id: 'claude-code', name: 'Claude Code', chats }, { id: 'codex', name: 'Codex', chats: 0 }] };
  } } });
  try {
    const { page } = f; page.setDefaultTimeout(7000);
    await openSettings(page, 'Import chats');
    const panel = page.locator('#settings-panel-import');
    await panel.getByText('No chats from the last 30 days.').first().waitFor();
    chats = 2;
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    const hidden = reads;
    await page.waitForTimeout(300);
    assert.equal(reads, hidden, 'a hidden Import chats page does not read the counts');
    await page.getByRole('tab', { name: 'Import chats', exact: true }).click();
    await panel.getByText('2 chats from the last 30 days.').waitFor();
    chats = 1;
    await openSettings(page, 'Import chats');
    await panel.getByText('1 chat from the last 30 days.').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
