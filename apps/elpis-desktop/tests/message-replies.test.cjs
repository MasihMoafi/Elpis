const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');
const fs = require('node:fs');
const path = require('node:path');
const preview = page => page.locator('.composer [data-slot="reply-preview"]');
const reply = async page => page.locator('.message.agent').first().getByRole('button', { name: 'Reply', exact: true }).click();
async function using(options, run) { const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, ...options }); try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); } finally { await f.close(); } }
const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
const firstPicture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVR4nGMQiT2DFTEMLQkAyYpPQS+5mBEAAAAASUVORK5CYII=', 'base64');
test('uploaded pictures and viewed-image thumbnails reply to their own source and bytes', () => using({ chat: [['image-turn', 'My picture', 'Pictures ready']], routes: {
  '/api/threads/chat-a': () => ({ thread: { id: 'chat-a', name: 'Fix the parser', cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' } }, nextCursor: null, data: [
    { turnId: 'image-turn', item: { id: 'answer', type: 'agentMessage', text: 'Pictures ready' } },
    { turnId: 'image-turn', item: { id: 'viewed', type: 'imageView', path: '/tmp/viewed.png' } },
    { turnId: 'image-turn', item: { id: 'uploaded', type: 'userMessage', content: [{ type: 'text', text: 'My picture' }, { type: 'image', url: `data:image/png;base64,${firstPicture.toString('base64')}`, name: 'uploaded.png' }] } },
  ] }),
} }, async f => {
  const { page, composer } = f;
  await page.route('**/items/viewed/media/0', route => route.fulfill({ contentType: 'image/png', body: picture }));
  await page.getByRole('button', { name: 'Reply to image: uploaded.png', exact: true }).click();
  await preview(page).getByText('Replying to You', { exact: true }).waitFor();
  assert.equal(await preview(page).getByRole('img', { name: 'uploaded.png' }).getAttribute('src'), `data:image/png;base64,${firstPicture.toString('base64')}`);
  await preview(page).getByRole('button', { name: 'Cancel reply', exact: true }).click();
  await page.locator('.worked-for > summary').click();
  await page.getByRole('button', { name: 'Reply to image: viewed.png', exact: true }).click();
  await preview(page).getByText('Replying to Elpis', { exact: true }).waitFor();
  await preview(page).getByRole('button', { name: 'Jump to original message' }).click();
  assert.match(await page.evaluate(() => document.activeElement.dataset.imageReference), /viewed/);
  await composer.fill('This picture'); await composer.press('Enter');
  await page.waitForFunction(() => !document.querySelector('.composer [data-slot="reply-preview"]'));
  const sent = f.posts.find(p => p.path === '/api/threads/chat-a/turns');
  assert.equal(sent.body.attachments.find(part => part.type === 'image').dataUrl, `data:image/png;base64,${picture.toString('base64')}`);
  assert.ok(sent.body.attachments.some(part => part.type === 'text' && part.text.includes('viewed')));
}));
test('an image that stops being readable adds no incomplete reply or image', () => using({ chat: [['picture', 'Make a logo', '![Logo](https://images.example/unavailable.png)'], ['tail', 'Ready?', 'Picture ready']] }, async f => {
  const { page, composer } = f;
  await page.route('https://images.example/**', route => route.request().resourceType() === 'image'
    ? route.fulfill({ contentType: 'image/png', body: picture })
    : route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.reload(); await f.open('chat-a'); await composer.fill('Keep this draft');
  await page.getByRole('button', { name: 'Reply to image: Logo', exact: true }).click();
  await page.getByText('This image could not be attached. Try again after it loads.', { exact: true }).waitFor();
  assert.equal(await preview(page).count(), 0); assert.equal(await page.locator('.composer img').count(), 0);
  assert.equal(await composer.inputValue(), 'Keep this draft');
}));
for (const colorScheme of ['light', 'dark']) test(`reply to one picture sends that image, preserves the draft and cancels cleanly (${colorScheme})`, () => using({ colorScheme, chat: [['pictures', 'Make two logos', '![First logo](https://images.example/first.png)\n\n![Second logo](https://images.example/second.png)'], ['tail', 'Ready?', 'Pictures ready']] }, async f => {
  const { page, composer } = f;
  await page.route('https://images.example/**', route => route.fulfill({ contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' }, body: route.request().url().endsWith('/first.png') ? firstPicture : picture }));
  await page.reload(); await f.open('chat-a');
  await page.getByRole('img', { name: 'Second logo', exact: true }).waitFor();
  await page.locator('input[aria-label="Choose files"]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep this file') });
  await composer.fill('Keep my words');
  await page.getByRole('button', { name: 'Reply to image: First logo', exact: true }).click();
  await preview(page).getByRole('img', { name: 'First logo', exact: true }).waitFor();
  await page.keyboard.type('!'); assert.equal(await composer.inputValue(), 'Keep my words!');
  await page.getByRole('button', { name: 'Reply to image: Second logo', exact: true }).click();
  await preview(page).getByRole('img', { name: 'Second logo', exact: true }).waitFor();
  assert.equal(await preview(page).getByRole('img', { name: 'First logo', exact: true }).count(), 0);
  await preview(page).getByRole('button', { name: 'Cancel reply', exact: true }).click();
  assert.equal(await page.locator('.composer img').count(), 0, 'cancel removes the reply image');
  assert.equal(await composer.inputValue(), 'Keep my words!');
  assert.equal(await page.locator('.composer').getByText('notes.txt', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Reply to image: Second logo', exact: true }).click();
  await preview(page).getByRole('img', { name: 'Second logo', exact: true }).waitFor();
  await f.open('chat-b'); await f.open('chat-a'); await page.reload(); await f.open('chat-a');
  await preview(page).getByRole('img', { name: 'Second logo', exact: true }).waitFor();
  if (process.env.ELPIS_REPLY_SHOTS) { fs.mkdirSync(process.env.ELPIS_REPLY_SHOTS, { recursive: true }); await page.screenshot({ path: path.join(process.env.ELPIS_REPLY_SHOTS, `image-reply-${colorScheme}.png`) }); }
  await composer.press('Enter'); await page.waitForFunction(() => !document.querySelector('.composer [data-slot="reply-preview"]'));
  const sent = f.posts.find(p => p.path === '/api/threads/chat-a/turns');
  const images = sent.body.attachments.filter(part => part.type === 'image');
  assert.equal(images.length, 1); assert.equal(images[0].dataUrl, `data:image/png;base64,${picture.toString('base64')}`);
  assert.equal(images[0].name, 'Second logo');
  assert.ok(sent.body.attachments.some(part => part.name === 'notes.txt'));
  assert.ok(sent.body.attachments.some(part => part.type === 'text' && part.text.includes('Second logo') && part.text.includes('pictures')));
}));
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
    const end = document.createTreeWalker(document.querySelectorAll('.user-turn .message.user')[1], NodeFilter.SHOW_TEXT).nextNode(); // its text sits inside the fold wrapper (540411af9)
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
  await page.waitForFunction(element => document.activeElement === element, await composer.elementHandle(), { timeout: 6000 });
  assert.equal(await composer.evaluate(element => document.activeElement === element), true, 'closing the menu leaves focus in the composer');
  await page.keyboard.type('From the menu');
  assert.equal(await composer.inputValue(), 'From the menu');
  await preview(page).getByRole('button', { name: 'Cancel reply' }).click(); await composer.fill('');
  await page.locator('.user-turn').first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Reply' }).click(); await preview(page).waitFor();
  await page.waitForFunction(element => document.activeElement === element, await composer.elementHandle(), { timeout: 6000 });
  assert.equal(await composer.evaluate(element => document.activeElement === element), true, 'closing the menu leaves focus in the composer');
  await page.keyboard.type('From right-click');
  assert.equal(await composer.inputValue(), 'From right-click');
}));
