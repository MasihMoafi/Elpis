const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, TURNS } = require('./parity-fixture.cjs');
const { widenSidePanel } = require('./controls.cjs');

async function using(options, run) {
  const f = await fixture({ width: 1280, height: 800, ...options });
  try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); }
  finally { await f.close(); }
}
const panel = async page => { await page.getByRole('button', { name: 'Show side panel', exact: true }).click(); };

test('820px keeps a usable chat and composer beside the panel with a drawer sidebar', () => using({ width: 820 }, async ({ page, composer }) => {
  const sidebar = await page.locator('aside.sidebar').boundingBox();
  await panel(page);
  assert.equal(await composer.isVisible(), true);
  const chat = await page.locator('.chat-view').boundingBox(), side = await page.locator('.side-panel').boundingBox();
  // The panel opens as wide as the sidebar was (A217: "same size of th left pane").
  assert.ok(chat.width >= 360 && Math.abs(side.width - sidebar.width) <= 2, JSON.stringify({ chat, side, sidebar }));
  assert.ok(chat.x + chat.width <= side.x + 1);
  await composer.fill('A draft beside the panel');
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).first().click();
  await page.locator('.sidebar.open').waitFor();
  await page.getByRole('button', { name: 'Close sidebar', exact: true }).last().click();
  assert.equal(await composer.inputValue(), 'A draft beside the panel');
}));

for (const running of [false, true]) test(`composer labels fit at every desktop width, panel open and closed (${running ? 'running' : 'idle'})`, () => using({ running }, async ({ page, composer }) => {
  for (const width of [820, 1130, 1280, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const open of [false, true]) {
      if (open) await panel(page);
      assert.equal(await composer.isVisible(), true, `${width}px panel ${open}`);
      const clipped = await page.locator('.composer-controls').evaluate(root => [...root.querySelectorAll('button, button span')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map(el => ({ text: el.textContent, width: el.clientWidth, needed: el.scrollWidth })));
      assert.deepEqual(clipped, [], `${width}px panel ${open}`);
      const box = await page.locator('.composer').boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= width);
      if (open) await page.getByRole('button', { name: 'Close side panel', exact: true }).click();
    }
  }
}));

test('the prompt rail yields to chat text in a narrow pane', () => using({ width: 1280 }, async ({ page }) => {
  assert.equal(await page.locator('.prompt-rail').isVisible(), true);
  await panel(page);
  assert.equal(await page.locator('.prompt-rail').isVisible(), true);
  // The panel opens as wide as the sidebar (A217), which leaves the chat wide; widening it narrows the chat to 640px or less.
  await widenSidePanel(page, 420);
  assert.ok((await page.locator('.chat-view').boundingBox()).width <= 640);
  assert.equal(await page.locator('.prompt-rail').isVisible(), false);
}));

test('elapsed work keeps lowercase time units', () => using({ chat: [['t1', 'Explain.', 'Done.', [{ id: 'r1', type: 'reasoning', summary: ['Thinking'] }]]] }, async ({ page }) => {
  const label = await page.locator('.worked-for > summary').innerText();
  assert.match(label, /\d+s\b/);
  assert.doesNotMatch(label, /\dS\b/);
}));

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


test('the sidebar closes beside its brand and reopens from the title bar without losing the chat draft', () => using({}, async ({ page, composer }) => {
  await composer.fill('Keep my draft while moving the sidebar.');
  const brand = page.locator('.sidebar .brand');
  const close = brand.getByRole('button', { name: 'Close sidebar', exact: true });
  const home = await brand.getByRole('button', { name: 'Elpis home', exact: true }).boundingBox();
  const control = await close.boundingBox();
  assert.ok(control.x >= home.x + home.width, 'close sits to the right of the brand');
  assert.ok(Math.abs(control.y + control.height / 2 - home.y - home.height / 2) < 1, 'brand and close share a center line');
  assert.equal(await page.locator('.title-bar').getByRole('button', { name: 'Close sidebar', exact: true }).count(), 0);
  await close.click();
  await page.locator('.title-bar').getByRole('button', { name: 'Open sidebar', exact: true }).click();
  assert.equal(await close.isVisible(), true);
  assert.equal(await composer.inputValue(), 'Keep my draft while moving the sidebar.');
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
  assert.equal(await composer.inputValue(), 'Keep this draft behind the panel.');
}));
