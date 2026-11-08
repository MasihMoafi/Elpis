const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, TURNS } = require('./parity-fixture.cts');

async function using(options: Record<string, unknown>, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture({ width: 1280, height: 800, ...options });
  try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); }
  finally { await f.close(); }
}
const panel = async (page: Awaited<ReturnType<typeof fixture>>['page']) => { await page.getByRole('button', { name: 'Show side panel', exact: true }).click(); };

test('non-chat views get the whole workspace while the panel stays hidden', () => using({ width: 820 }, async ({ page }) => {
  await panel(page);
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).first().click();
  await page.getByRole('button', { name: 'Lab', exact: true }).click();
  await page.getByRole('heading', { name: 'Lab', exact: true }).first().waitFor();
  assert.equal(await page.locator('.side-panel').isVisible(), false);
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  assert.equal(await page.locator('.side-panel').isVisible(), false);
}));

test('a turn is visibly working before its first entry arrives', () => using({ running: true, chat: TURNS.slice(0, 3), routes: {
  '/api/threads/chat-a': () => ({ thread: { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'active' } }, data: TURNS.slice(0, 3).flatMap(([id, prompt, reply]: string[]) => [
    { turnId: id, item: { id: `u-${id}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] } },
    { turnId: id, item: { id: `a-${id}`, type: 'agentMessage', text: reply } },
  ]).reverse(), nextCursor: null }),
} }, async ({ page }) => {
  await page.locator('.turn-working').waitFor();
  assert.match(await page.locator('.turn-working').innerText(), /Working/);
}));

test('a message sent during a running turn has room above it and Working stays close below it', () => using({ running: true, chat: TURNS.slice(0, 3), routes: {
  '/api/threads/chat-a': () => ({ thread: { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'active' } }, data: [
    ...TURNS.slice(0, 3).flatMap(([id, prompt, reply]: string[]) => [
      { turnId: id, item: { id: `u-${id}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] } },
      { turnId: id, item: { id: `a-${id}`, type: 'agentMessage', text: reply } },
    ]),
    { turnId: 'live', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'first' }] } },
    { turnId: 'live', item: { id: 'c1', type: 'commandExecution', command: 'ls', status: 'completed', aggregatedOutput: '' } },
    { turnId: 'live', item: { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'sent while it ran' }] } },
  ].reverse(), nextCursor: null }),
} }, async ({ page }) => {
  await page.locator('.turn-working').waitFor();
  const bubble = page.locator('.user-turn').filter({ hasText: 'sent while it ran' });
  assert.equal(await bubble.evaluate((node: Element) => getComputedStyle(node).marginTop), '24px');
  await page.locator('.chat-scroll').evaluate((node: Element) => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(200);
  const message = await bubble.locator('.message.user').boundingBox(), working = await page.locator('.turn-working').boundingBox();
  const gap = working.y - (message.y + message.height);
  assert.ok(gap >= 34 && gap <= 56, `gap below the last message was ${gap}px`);
}));

for (const mode of ['drawer', 'floating']) test(`reconnect status stays at the workspace bottom with the ${mode} panel hiding the chat`, () => using({}, async ({ page, composer, emit }) => {
  await composer.fill('Keep this draft behind the panel.');
  if (mode === 'drawer') await page.setViewportSize({ width: 720, height: 800 });
  await panel(page);
  if (mode === 'floating') {
    await page.getByRole('button', { name: 'Enter full view', exact: true }).click();
    await page.getByRole('button', { name: 'Collapse floating chat', exact: true }).click();
  }
  emit('connection', { connected: false });
  const status = page.getByRole('status').filter({ hasText: 'Reconnecting to Elpis' });
  await status.waitFor();
  const notice = await status.boundingBox(), workspace = await page.locator('main.workspace').boundingBox();
  assert.ok(notice.y >= workspace.y + workspace.height * .7, 'reconnect remains visible at the bottom');
  emit('connection', { connected: true });
  await status.waitFor({ state: 'detached' });
  if (mode === 'drawer') await page.getByRole('button', { name: 'Close side panel', exact: true }).click();
  else await page.getByRole('button', { name: /^Restore floating chat:/ }).click();
  assert.equal(await composer.inputValue(), 'Keep this draft behind the panel.');
}));
