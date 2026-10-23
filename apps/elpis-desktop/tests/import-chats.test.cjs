// Masih, 23 Oct: "we should add the import chats options like cloudroom does." Settings → Import chats lists the apps that have chats, imports on press, says what happened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

test('Import chats offers each app with its chats, imports on press, reports the result and refreshes the list', async () => {
  let sources = [{ id: 'claude-code', name: 'Claude Code', chats: 3 }, { id: 'codex', name: 'Codex', chats: 60 }];
  const posts = [];
  const f = await fixture({ routes: { '/api/import-chats': body => {
    if (!body) return { days: 30, atATime: 50, sources };
    posts.push(body); sources = sources.filter(source => source.id !== body.source);
    return body.source === 'claude-code' ? { imported: 2, skipped: ['This chat is empty.'] } : { imported: 50, skipped: [] };
  } } });
  try {
    const { page } = f; page.setDefaultTimeout(7000);
    await openSettings(page); await page.getByRole('tab', { name: 'Import chats', exact: true }).click();
    const panel = page.getByRole('tabpanel');
    await panel.getByText('Bring your Claude Code and Codex chats over as Elpis chats.', { exact: false }).waitFor();
    await panel.getByText('3 chats from the last 30 days.').waitFor();
    await panel.getByText('60 chats from the last 30 days; 50 at a time.').waitFor();
    await panel.getByRole('button', { name: 'Import Claude Code chats' }).click();
    await panel.getByText('Imported 2 chats from Claude Code. 1 skipped: This chat is empty.').waitFor();
    assert.deepEqual(posts, [{ source: 'claude-code' }]);
    await panel.getByText('3 chats from the last 30 days.').waitFor({ state: 'detached' });
    assert.equal(await panel.getByRole('button', { name: 'Import Codex chats' }).textContent(), 'Import 50', 'one press imports at most 50');
    await panel.getByRole('button', { name: 'Import Codex chats' }).click();
    await panel.getByText('Imported 50 chats from Codex.').waitFor();
    await panel.getByText('No chats to import').waitFor({ state: 'detached' }); // the result stays up until the next press
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
