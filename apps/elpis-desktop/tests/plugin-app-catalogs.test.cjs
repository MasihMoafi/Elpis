// S10: the Plugins tab offers the catalogs the Claude and ChatGPT apps already keep on this computer, one click each.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('the Plugins tab offers each app\'s catalog until it is added', async () => {
  const added = new Set(), posts = [];
  const catalog = () => ({ marketplaces: [...added].map(app => ({ name: `${app}-market`, displayName: `${app} market`, path: `/${app}` })),
    appCatalogs: [{ app: 'claude', label: 'Claude', added: added.has('claude') }, { app: 'chatgpt', label: 'ChatGPT', added: added.has('chatgpt') }], plugins: [], errors: [], nextCursor: null });
  const f = await fixture({ width: 1280, height: 800, routes: {
    '/api/customize': () => ({ skills: { data: [], errors: [] }, plugins: { data: [] }, connectors: { data: [] } }),
    '/api/customize/plugins': catalog,
    '/api/customize/marketplace': body => { posts.push(body); if (body.action === 'add-app') added.add(body.app); return {}; },
  } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
    await page.getByRole('radiogroup', { name: 'Customize', exact: true }).getByRole('radio', { name: 'Plugins', exact: true }).click();
    await page.getByRole('button', { name: 'Add plugins', exact: true }).click();
    const claude = page.getByRole('button', { name: 'Add the Claude plugins', exact: true }), chatgpt = page.getByRole('button', { name: 'Add the ChatGPT plugins', exact: true });
    await claude.waitFor(); await chatgpt.waitFor();
    await claude.click();
    await claude.waitFor({ state: 'detached' });
    assert.deepEqual(posts, [{ action: 'add-app', app: 'claude' }]);
    assert.equal(await chatgpt.count(), 1, 'the other catalog is still offered');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
