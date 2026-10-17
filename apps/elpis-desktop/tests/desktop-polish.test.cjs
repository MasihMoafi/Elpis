const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, TURNS } = require('./parity-fixture.cjs');

async function using(options, run) {
  const f = await fixture({ width: 1280, height: 800, ...options });
  try { await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []); }
  finally { await f.close(); }
}
const panel = async page => { await page.getByRole('button', { name: 'Show side panel', exact: true }).click(); };

test('820px keeps a usable chat and composer beside the panel with a drawer sidebar', () => using({ width: 820 }, async ({ page, composer }) => {
  await panel(page);
  assert.equal(await composer.isVisible(), true);
  const chat = await page.locator('.chat-view').boundingBox(), side = await page.locator('.side-panel').boundingBox();
  assert.ok(chat.width >= 360 && side.width >= 360, JSON.stringify({ chat, side }));
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
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.locator('.agent-title').first().waitFor();
  assert.equal(await page.locator('.side-panel').isVisible(), false);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  assert.equal(await page.locator('.side-panel').isVisible(), false);
}));

test('agent titles have room and metadata sits underneath at 820px', () => using({ width: 820 }, async ({ page }) => {
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await page.locator('.agent-title').first().waitFor();
  const size = await page.locator('.agent-title-line').first().boundingBox();
  assert.ok(size.width >= 100, JSON.stringify(size));
  assert.equal(await page.locator('.agent-title').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, 'the complete title is visible');
  const stacked = await page.locator('.agent-main').first().evaluate(el => {
    const title = el.querySelector('.agent-title-line').getBoundingClientRect(), meta = el.querySelector('.agent-meta').getBoundingClientRect();
    return meta.top >= title.bottom;
  });
  assert.equal(stacked, true);
  // Disabling the fix reproduces the original competing title/metadata columns.
  const oldColumns = await page.addStyleTag({ content: '@container workspace (max-width:760px) { .agent-main { grid-template-columns:minmax(0,1fr) auto; } }' });
  const oldStacked = await page.locator('.agent-main').first().evaluate(el => el.querySelector('.agent-meta').getBoundingClientRect().top >= el.querySelector('.agent-title-line').getBoundingClientRect().bottom);
  assert.equal(oldStacked, false, 'the check detects the original layout');
  await oldColumns.evaluate(el => el.remove());
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
