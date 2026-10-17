const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

for (const colorScheme of ['light', 'dark']) test(`long input hints show an ellipsis and expose their complete text (${colorScheme})`, async () => {
  const f = await fixture({ width: 900, height: 700, colorScheme, routes: {
    '/api/mcp': () => ({ version: 'm1', servers: [{ name: 'rag', enabled: true, command: 'rag-mcp', transport: 'stdio', credentials: [] }], write: { available: true } }),
    '/api/tools/rag': () => ({ stages: [], keys: { openrouter: false } }),
  } }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await openSettings(page); await page.getByRole('tab', { name: 'MCP servers', exact: true }).click();
    for (const name of ['RAG answer model', 'RAG reranker']) {
      const input = page.getByRole('textbox', { name, exact: true }); await input.waitFor(); await input.hover();
      const hint = await input.getAttribute('placeholder');
      assert.equal(await input.getAttribute('title'), hint, 'the complete example remains available on hover');
      assert.equal(await input.evaluate(el => getComputedStyle(el).textOverflow), 'ellipsis', 'a cropped hint is visibly abbreviated');
      await input.click(); await page.keyboard.type('example/model');
      assert.equal(await input.inputValue(), 'example/model', 'typing keeps the complete value');
    }
    // A field with an explicit title (the selected agent's name) retains it.
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    await page.getByRole('button', { name: /^Voting/ }).click();
    await page.locator('.react-flow__node-agent').first().click();
    const name = page.getByRole('textbox', { name: 'Name', exact: true });
    assert.equal(await name.getAttribute('title'), await name.inputValue());
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
