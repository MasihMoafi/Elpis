const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

test('Love Spot is beside Canvas and loads its editor only after a real click', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await page.locator('.excalidraw').count(), 0);
    const chunks = path.resolve(__dirname, '../out/_next/static/chunks');
    const heavy = [];
    for (const name of await fs.readdir(chunks)) if (name.endsWith('.js') && (await fs.stat(path.join(chunks, name))).size > 200_000 && (await fs.readFile(path.join(chunks, name), 'utf8')).includes('getSceneElementsIncludingDeleted')) heavy.push(name);
    assert.ok(heavy.length, 'the check must identify the actual Excalidraw bundle');
    assert.equal(f.requests.some(url => heavy.some(name => url.endsWith(name))), false, 'opening chat must not load Excalidraw');
    const love = page.getByRole('button', { name: 'Love Spot', exact: true });
    await love.click();
    assert.equal(await page.locator('.nav-list button').evaluateAll(nodes => { const i = nodes.findIndex(n => n.textContent === 'Love Spot'); return nodes[i - 1]?.textContent; }), 'Workflows');
    assert.equal(await love.getAttribute('aria-current'), 'page');
    const icon = love.locator('svg');
    assert.equal(await icon.getAttribute('width'), '16');
    await page.locator('.excalidraw').waitFor();
    assert.ok(f.requests.some(url => heavy.some(name => url.endsWith(name))), 'opening Love Spot must load Excalidraw');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
