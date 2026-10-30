const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

const preview = { available: true, version: 'checked', files: ['src/parser.ts'], added: 1, removed: 1, diff: 'diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -1 +1 @@\n-after\n+before\n' };
async function openRewind(f) {
  await f.page.locator('.message.user', { hasText: 'Add tests.' }).click({ button: 'right' });
  await f.page.getByRole('menuitem', { name: 'Rewind to here' }).click();
  return f.page.getByRole('alertdialog');
}
async function chooseRestore(dialog, mode) {
  const select = dialog.getByLabel('Restore', { exact: true }); await select.press('Enter');
  await dialog.page().getByRole('option', { name: { both: 'Code and conversation', conversation: 'Conversation only', code: 'Code only' }[mode], exact: true }).click();
  assert.equal(await select.innerText(), { both: 'Code and conversation', conversation: 'Conversation only', code: 'Code only' }[mode]);
}
for (const mode of ['both', 'conversation', 'code']) test(`rewind ${mode}: selects restore scope with real keys, previews files and sends the confirmed version`, async () => {
  let f, action; f = await fixture({ routes: {
    '/api/threads/chat-a/rewind': (body) => {
      if (body.action === 'preview') return preview;
      if (body.action === 'status') return { action };
      if (body.action === 'restore') { if (body.mode !== 'code') f.turns.length = 2; action = body.mode === 'code' ? undefined : 'undo'; return { rewound: true, mode: body.mode, undo: action }; }
      if (body.action === 'undo') { f.turns.push(['t3', 'Add tests.', 'Added three tests.'], ['t4', 'Run them.', 'All green.']); action = 'redo'; return { undo: action }; }
      if (body.action === 'redo') { f.turns.length = 2; action = 'undo'; return { undo: action }; }
    },
  } });
  try {
    await f.open('chat-a'); const dialog = await openRewind(f);
    await chooseRestore(dialog, mode);
    if (mode !== 'conversation') { await dialog.getByText('1 file', { exact: false }).waitFor(); assert.match(await dialog.innerText(), /\+1.*−1/s); await dialog.getByText('View changes').click(); await dialog.getByText('+before', { exact: true }).waitFor(); }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); assert.equal(f.posts.filter(p => p.body.action === 'restore').length, 0);
    const again = await openRewind(f); await chooseRestore(again, mode);
    await again.getByRole('button', { name: 'Rewind', exact: true }).click(); await again.waitFor({ state: 'hidden' });
    assert.deepEqual(f.posts.find(p => p.body.action === 'restore').body, { action: 'restore', beforeTurnId: 't3', mode, ...(mode === 'conversation' ? {} : { version: 'checked' }) });
    if (mode === 'code') { await f.page.getByText('All green.', { exact: true }).waitFor(); assert.equal(await f.composer.inputValue(), ''); }
    else {
      await f.page.getByText('All green.', { exact: true }).waitFor({ state: 'hidden' }); assert.equal(await f.composer.inputValue(), 'Add tests.');
      await f.page.getByRole('button', { name: 'Undo rewind', exact: true }).click(); await f.page.getByText('All green.', { exact: true }).waitFor();
      await f.page.getByRole('button', { name: 'Redo rewind', exact: true }).click(); await f.page.getByText('All green.', { exact: true }).waitFor({ state: 'hidden' });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('missing snapshot allows conversation only; a failed restore stays reviewable in the dialog', async () => {
  const f = await fixture({ routes: { '/api/threads/chat-a/rewind': body => body.action === 'preview' ? { available: false, reason: 'No file checkpoint for this message.' } : { __http: 409, error: 'The conversation changed. Try again.' } } });
  try { await f.open('chat-a'); const dialog = await openRewind(f); const restore = dialog.getByLabel('Restore', { exact: true });
    await restore.waitFor(); assert.equal(await restore.innerText(), 'Conversation only');
    await restore.click(); assert.equal(await f.page.getByRole('option', { name: 'Code only', exact: true }).getAttribute('aria-disabled'), 'true'); await f.page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: 'Rewind', exact: true }).click(); await dialog.getByRole('alert').getByText('The conversation changed. Try again.').waitFor();
    await f.page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); await f.page.getByText('All green.', { exact: true }).waitFor();
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) for (const [width, height] of [[1280, 800], [900, 700]]) test(`rewind fits ${colorScheme} ${width}×${height}`, async () => {
  const f = await fixture({ colorScheme, width, height, routes: { '/api/threads/chat-a/rewind': () => preview } });
  try { await f.open('chat-a'); const dialog = await openRewind(f); await dialog.getByLabel('Restore', { exact: true }).waitFor(); await dialog.getByText('View changes').click(); await assertUiFit(dialog, 'rewind dialog');
    const dir = path.resolve('../../.tmp/rewind'); await fs.mkdir(dir, { recursive: true }); await f.page.screenshot({ path: path.join(dir, `${colorScheme}-${width}.png`) });
  } finally { await f.close(); }
});

test('a stopped turn still edits its first visible message when recorded items arrive out of order', async () => {
  const f = await fixture();
  try {
    await f.open('chat-a');
    for (const text of ['original message', 'first follow-up', 'second follow-up']) {
      await f.composer.fill(text); await f.composer.press('Enter');
      await f.page.locator('.user-turn', { hasText: text }).waitFor();
      if (text === 'original message') await f.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    }
    const item = (id, text) => f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 't-new', item: { id, type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] } } });
    item('follow-1', 'first follow-up'); item('follow-2', 'second follow-up');
    f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 't-new', status: 'interrupted' } } });
    await f.page.getByText('Stopped. The reply above is where it was when the turn was stopped.').waitFor();
    const first = f.page.locator('.user-turn', { hasText: 'original message' });
    await first.getByRole('button', { name: 'Why editing is unavailable', exact: true }).click();
    await first.getByText("Wait for this turn's messages to be recorded before editing.").waitFor();
    item('original', 'original message');
    await first.getByRole('button', { name: 'Edit message', exact: true }).waitFor();
    await first.locator('.message.user').click({ button: 'right' });
    await f.page.getByRole('menuitem', { name: 'Rewind to here', exact: true }).click();
    const dialog = f.page.getByRole('alertdialog');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /original message/, `message order: ${(await f.page.locator('.user-turn').allInnerTexts()).join(' | ')}`);
    await f.page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    await first.getByRole('button', { name: 'Edit message', exact: true }).click();
    assert.equal(await f.page.getByRole('textbox', { name: 'Edited message', exact: true }).inputValue(), 'original message');
    for (const text of ['first follow-up', 'second follow-up']) {
      assert.equal(await f.page.locator('.user-turn', { hasText: text }).getByRole('button', { name: 'Why editing is unavailable' }).count(), 1);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
