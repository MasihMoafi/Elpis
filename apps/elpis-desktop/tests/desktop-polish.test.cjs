const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, TURNS } = require('./parity-fixture.cjs');

async function using(options, run) {
  const f = await fixture({ width: 1280, height: 800, ...options });
  try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); }
  finally { await f.close(); }
}
const panel = async page => { await page.getByRole('button', { name: 'Show side panel', exact: true }).click(); };

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
  '/api/threads/chat-a': () => ({ thread: { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'active' } }, data: TURNS.slice(0, 3).flatMap(([id, prompt, reply]) => [
    { turnId: id, item: { id: `u-${id}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] } },
    { turnId: id, item: { id: `a-${id}`, type: 'agentMessage', text: reply } },
  ]).reverse(), nextCursor: null }),
} }, async ({ page }) => {
  await page.locator('.turn-working').waitFor();
  assert.match(await page.locator('.turn-working').innerText(), /Working/);
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
