const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const fs = require('node:fs');
const path = require('node:path');
const preview = page => page.locator('.composer [data-slot="reply-preview"]');
const reply = async page => page.locator('.message.agent').first().getByRole('button', { name: 'Reply', exact: true }).click();
async function using(options, run) { const f = await fixture(options); try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); } finally { await f.close(); } }
for (const colorScheme of ['light', 'dark']) test(`reply quotes either author, preserves files and text, and can be cancelled (${colorScheme})`, () => using({ colorScheme }, async f => {
  const { page, composer } = f;
  await composer.fill('Keep this draft');
  await page.locator('input[aria-label="Choose files"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this file') });
  await reply(page); await preview(page).getByText('Replying to Elpis', { exact: true }).waitFor();
  await page.keyboard.type(' and more');
  assert.equal(await composer.inputValue(), 'Keep this draft and more', 'after Reply the cursor is in the message box, ready to type');
  await composer.fill('Keep this draft');
  assert.match(await preview(page).innerText(), /parser/);
  await page.locator('.user-turn').first().getByRole('button', { name: 'Reply', exact: true }).click();
  await preview(page).getByText('Replying to You', { exact: true }).waitFor();
  assert.equal(await preview(page).count(), 1);
  assert.equal(await page.locator('.composer').getByText('notes.txt', { exact: true }).count(), 1);
  if (process.env.ELPIS_REPLY_SHOTS) { fs.mkdirSync(process.env.ELPIS_REPLY_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.ELPIS_REPLY_SHOTS, `reply-${colorScheme}.png`) }); }
  await preview(page).getByRole('button', { name: 'Cancel reply', exact: true }).click();
  assert.equal(await preview(page).count(), 0); assert.equal(await composer.inputValue(), 'Keep this draft');
}));
test('quoted context survives switching chats and reload, reaches the send, and links to the original', () => using({}, async f => {
  const { page, composer } = f; await reply(page); await composer.fill('Can you explain this part?');
  await f.open('chat-b'); assert.equal(await preview(page).count(), 0);
  await f.open('chat-a'); await preview(page).waitFor();
  await page.reload(); await f.open('chat-a'); await preview(page).waitFor();
  assert.equal(await composer.inputValue(), 'Can you explain this part?');
  await preview(page).getByRole('button', { name: 'Jump to original message' }).click();
  assert.equal(await page.locator('.message.agent').first().evaluate(e => e === document.activeElement), true);
  await composer.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.composer [data-slot="reply-preview"]'));
  const sent = f.posts.find(p => p.path === '/api/threads/chat-a/turns');
  assert.equal(sent.body.text, 'Can you explain this part?');
  assert.match(sent.body.attachments[0].text, /Replying to Elpis/); assert.match(sent.body.attachments[0].text, /parser/);
  assert.ok(await page.locator('.message.user [data-slot="reply-preview"]').count());
}));
test('a rejected send restores its reply; cancelling removes that context from the next send', () => using({ routes: { '/api/threads/chat-a/turns': () => ({ __http: 503, error: 'Fixture send unavailable' }) } }, async f => {
  const { page, composer } = f; await reply(page); await composer.fill('Explain this'); await composer.press('Enter');
  await preview(page).waitFor(); await page.getByText('Fixture send unavailable', { exact: false }).first().waitFor();
  assert.equal(await composer.inputValue(), 'Explain this');
  await preview(page).getByRole('button', { name: 'Cancel reply', exact: true }).click();
  await page.route('**/api/threads/chat-a/turns', route => route.fulfill({ json: { turn: { id: 'retry' } } }));
  let sent; page.on('request', r => { if (r.url().endsWith('/turns') && r.method() === 'POST') sent = r.postDataJSON(); });
  const retry = page.waitForRequest(r => r.url().endsWith('/turns') && r.method() === 'POST');
  await composer.press('Enter'); await retry; assert.equal(sent.attachments, undefined);
}));

test('dragging a passage offers Quote selection and quotes only those words; selecting the composer offers none', () => using({}, async f => {
  const { page, composer } = f;
  const words = page.locator('.message.agent').first().locator('strong').first(); await words.scrollIntoViewIfNeeded();
  const box = await words.boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  const selected = await page.evaluate(() => getSelection().toString().trim()); assert.ok(selected.length > 2);
  await page.getByRole('button', { name: 'Quote selection', exact: true }).click();
  assert.equal(await preview(page).locator('.line-clamp-2').innerText(), selected);
  await page.keyboard.type('Why?'); assert.equal(await composer.inputValue(), 'Why?', 'after Quote selection the cursor is in the message box'); await composer.fill('');
  await preview(page).getByRole('button', { name: 'Cancel reply' }).click();
  await composer.fill('Select this draft'); await composer.press('Control+a');
  assert.equal(await page.getByRole('button', { name: 'Quote selection', exact: true }).count(), 0);
}));

test('a selection across messages offers no quote, and Escape dismisses the selection action', () => using({}, async f => {
  const { page } = f;
  await page.evaluate(() => {
    const start = document.querySelector('.message.agent p').firstChild;
    const end = document.querySelectorAll('.user-turn .message.user')[1].firstChild;
    const range = document.createRange(); range.setStart(start, 0); range.setEnd(end, 3);
    getSelection().removeAllRanges(); getSelection().addRange(range);
  });
  await page.keyboard.press('Shift');
  assert.equal(await page.getByRole('button', { name: 'Quote selection', exact: true }).count(), 0);
  const words = page.locator('.message.agent').first().locator('strong').first();
  await words.scrollIntoViewIfNeeded(); const box = await words.boundingBox();
  await page.mouse.click(box.x + 1, box.y + box.height / 2); // Collapse the existing range before making a new selection.
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Quote selection', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Quote selection', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await preview(page).count(), 0);
}));

// Masih, 24 Oct: "after I quote the cursor must be in the chatbox so I could type immediately after". Older messages
// keep Reply in their menus; a closing menu must not pull focus back to its button. Every menu path is checked.
test('Reply from the … menu or the right-click menu leaves the cursor in the message box', () => using({}, async f => {
  const { page, composer } = f;
  const message = page.locator('.message.agent').first();
  await message.hover(); await message.getByRole('button', { name: 'More message actions' }).click();
  await page.getByRole('menuitem', { name: 'Reply' }).click(); await preview(page).waitFor();
  await page.keyboard.type('From the menu');
  assert.equal(await composer.inputValue(), 'From the menu');
  await preview(page).getByRole('button', { name: 'Cancel reply' }).click(); await composer.fill('');
  await page.locator('.user-turn').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reply' }).click(); await preview(page).waitFor();
  await page.keyboard.type('From right-click');
  assert.equal(await composer.inputValue(), 'From right-click');
}));
