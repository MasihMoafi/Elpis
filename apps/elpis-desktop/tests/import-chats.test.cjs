// Masih, 23 Oct: "we should add the import chats options like cloudroom does." Settings → Import chats lists Claude Code and Codex with their chats, imports on press, says what happened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

test('Import chats offers Claude Code and Codex with their chats, imports on press, reports the result and refreshes the list', async () => {
  let chats = 60, codex = 3;
  const posts = [];
  const f = await fixture({ routes: { '/api/import-chats': body => {
    if (!body) return { days: 30, atATime: 50, sources: [...(chats ? [{ id: 'claude-code', name: 'Claude Code', chats }] : []), ...(codex ? [{ id: 'codex', name: 'Codex', chats: codex }] : [])] };
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
    assert.equal(await panel.getByRole('button', { name: 'Import Codex chats' }).count(), 0, 'Codex leaves the list once its chats are in');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('with nothing to import it says so', async () => {
  const f = await fixture({ routes: { '/api/import-chats': () => ({ days: 30, atATime: 50, sources: [] }) } });
  try {
    await openSettings(f.page); await f.page.getByRole('tab', { name: 'Import chats', exact: true }).click();
    await f.page.getByText('No chats to import').waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
