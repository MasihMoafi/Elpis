const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');

for (const colorScheme of ['light', 'dark']) test(`${colorScheme} desktop recovery and narrow layout captures`, async () => {
  await fs.mkdir('/tmp/polish9/shots', { recursive: true });
  const f = await fixture({ width: 820, height: 800, colorScheme });
  try {
    const { page } = f;
    await page.addInitScript(() => {
      const Original = window.EventSource;
      window.__streams = [];
      window.EventSource = class extends Original { constructor(...args) { super(...args); window.__streams.push(this); } };
    });
    await page.reload(); await f.open('chat-a');
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    await page.screenshot({ path: `/tmp/polish9/shots/${colorScheme}-820-panel.png` });
    await page.getByRole('button', { name: 'Close side panel', exact: true }).click();
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.locator('.agent-title').first().waitFor();
    await page.screenshot({ path: `/tmp/polish9/shots/${colorScheme}-agents.png` });
    await f.open('chat-a');
    await page.evaluate(() => {
      for (const stream of window.__streams) stream.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 't4', error: { message: 'The connection ended. Try again in a moment.', codexErrorInfo: 'other' } } } }) }));
    });
    await page.locator('.failed-turn-card').waitFor();
    const padding = await page.locator('.failed-turn-card').evaluate(el => {
      const box = el.getBoundingClientRect(), title = el.querySelector('h3').getBoundingClientRect();
      return { left: title.left - box.left, top: title.top - box.top };
    });
    assert.ok(padding.left >= 12 && padding.top >= 12, JSON.stringify(padding));
    await page.screenshot({ path: `/tmp/polish9/shots/${colorScheme}-failed-turn.png` });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
