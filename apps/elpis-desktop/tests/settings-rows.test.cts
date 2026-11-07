const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { settingsFixture, visit } = require('./settings-row-audit.cjs');

test('General Speed does not offer unsupported Flex and preserves a saved unknown tier', async () => {
  for (const saved of [null, 'flex']) {
    const app = await settingsFixture('light', { routes: {
      '/api/settings': () => ({ version: 'v1', main: {}, background: {}, smartPrune: {}, memory: {}, options: { serviceTier: saved }, write: { available: true }, managed: {} }),
    } });
    try {
      await visit(app.page, 'General');
      await app.page.getByLabel('Speed', { exact: true }).click();
      await app.page.getByRole('listbox').waitFor();
      assert.equal(await app.page.getByRole('option', { name: 'Flex', exact: true }).count(), 0);
      if (saved) assert.equal(await app.page.getByRole('option', { name: 'flex', exact: true }).getAttribute('aria-disabled'), 'true');
      assert.equal(app.posts.filter((post: { path: string }) => post.path === '/api/settings').length, 0, 'opening the saved tier does not rewrite it');
    } finally { await app.close(); }
  }
});
