const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const secondary = page => page.frameLocator('iframe[title="Split session"]');
async function split(page, id = 'chat-b') {
  await page.locator(`.thread-row[data-thread-id="${id}"]`).getByRole('button', { name: /^Actions for/ }).click();
  await page.getByRole('menuitem', { name: 'Open session in split view', exact: true }).click();
  await secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
}
test('split chats keep separate composers, send to their own chat, focus with brackets, and close either pane', async () => {
  const f = await fixture({ width: 1400, height: 850, desktop: false }); const { page, composer } = f;
  try {
    await f.open('chat-a'); await composer.fill('left draft'); await split(page);
    const right = secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true });
    await right.fill('right draft'); assert.equal(await composer.inputValue(), 'left draft');
    await composer.click(); await page.keyboard.press('Control+]');
    assert.ok(await right.evaluate(el => el === document.activeElement));
    await page.keyboard.press('Control+['); assert.ok(await composer.evaluate(el => el === document.activeElement));
    await right.click(); const sent = page.waitForResponse(res => res.url().endsWith('/threads/chat-b/turns')); await page.keyboard.press('Enter'); await sent;
    assert.ok(f.posts.some(p => p.path === '/api/threads/chat-b/turns' && JSON.stringify(p.body).includes('right draft')));
    assert.equal(await composer.inputValue(), 'left draft');
    await secondary(page).getByRole('button', { name: 'Close split view', exact: true }).click();
    await page.locator('iframe[title="Split session"]').waitFor({ state: 'detached' });
    assert.equal(await composer.inputValue(), 'left draft');
    await split(page); await secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true }).fill('Keep the right draft'); await page.getByRole('button', { name: 'Close split view', exact: true }).click();
    await page.locator('iframe[title="Split session"]').waitFor({ state: 'detached' });
    await page.locator('.thread-row.active[data-thread-id="chat-b"]').waitFor();
    assert.equal(await composer.inputValue(), 'Keep the right draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
test('Alt+click opens a split; one chat receives the same live reply in both panes', async () => {
  const f = await fixture({ width: 1400, height: 850, desktop: false }); const { page } = f;
  try {
    await f.open('chat-a');
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click({ modifiers: ['Alt'] });
    await secondary(page).getByRole('textbox', { name: 'Message Elpis', exact: true }).waitFor();
    await secondary(page).getByText('All green.', { exact: true }).waitFor();
    f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 'shared', item: { id: 'shared-reply', type: 'agentMessage', text: 'Both panes receive this reply.' } } });
    await page.getByText('Both panes receive this reply.', { exact: true }).waitFor();
    await secondary(page).getByText('Both panes receive this reply.', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
for (const colorScheme of ['light', 'dark']) for (const width of [1400, 900]) test(`split view fits in ${colorScheme} at ${width}px`, async () => {
  const f = await fixture({ width, height: 850, colorScheme, desktop: false }); const { page } = f;
  try {
    await f.open('chat-a'); await split(page);
    await secondary(page).getByRole('heading', { name: 'Write the docs', exact: true }).waitFor();
    await assertUiFit(page.locator('.workspace'), 'primary pane fits');
    await assertUiFit(secondary(page).locator('.workspace'), 'secondary pane fits');
    const header = await page.locator('.workspace-header').boundingBox(), otherHeader = await secondary(page).locator('.workspace-header').boundingBox();
    assert.equal(header.height, otherHeader.height, 'both pane headers align');
    const left = await page.locator('.composer').boundingBox(), right = await page.locator('iframe').boundingBox();
    assert.ok(left.x + left.width <= right.x + 1, 'the chats are side by side');
    if (process.env.ELPIS_PARITY_SHOTS) await page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `split-${colorScheme}-${width}.png`) });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
