// Regression only: real-engine acceptance is ledger-engine.runtime.mjs and ledger-app.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');

const write = { version: 'ledger-v1', write: { available: true } };
function state() {
  const connectors = ['alpha', 'middle', 'omega'].map((name, i) => ({ name, transport: i === 1 ? 'http' : 'stdio', enabled: true }));
  const plugins = [{ id: 'docs@proof', name: 'Docs', description: 'Write documentation', marketplace: 'proof', enabled: true }];
  const available = { id: 'review@proof', pluginName: 'review', name: 'Review', description: 'Review code', marketplace: 'proof', marketplaceName: 'proof', marketplacePath: '/catalog/.claude-plugin/marketplace.json', installed: false, enabled: false, installable: true, reason: null };
  let markets = [], reject = false;
  const snapshot = () => ({ skills: { data: [] }, plugins: { data: plugins, ...write }, connectors: { data: connectors, ...write } });
  const catalog = () => ({ marketplaces: markets, plugins: markets.length ? [{ ...available }] : [], errors: [], nextCursor: null });
  const routes = {
    '/api/customize': snapshot,
    '/api/mcp': body => {
      if (reject) return { __http: 409, error: 'Settings changed in another client' };
      assert.equal(body.version, 'ledger-v1'); assert.equal(body.action, 'enable');
      connectors.find(item => item.name === body.name).enabled = body.enabled;
      return { servers: connectors, ...write };
    },
    '/api/customize/plugin': body => {
      if (reject) return { __http: 503, error: 'Plugin change rejected' };
      if (body.action === 'enable') { assert.equal(body.version, 'ledger-v1'); plugins.find(item => item.id === body.id).enabled = body.enabled; }
      if (body.action === 'uninstall') plugins.splice(plugins.findIndex(item => item.id === body.id), 1);
      if (body.action === 'install') { available.installed = true; plugins.push({ ...available, enabled: true }); }
      return { ...snapshot(), appsNeedingAuth: [] };
    },
    '/api/customize/plugins': (_body, url) => {
      const value = catalog();
      if (url.searchParams.get('search') && !'review'.includes(url.searchParams.get('search').toLowerCase())) value.plugins = [];
      return value;
    },
    '/api/customize/marketplace': body => {
      if (reject) return { __http: 400, error: 'Invalid marketplace source' };
      if (body.action === 'add') markets = [{ name: 'proof', displayName: 'Proof marketplace', path: '/catalog/.claude-plugin/marketplace.json' }];
      else markets = [];
      return {};
    },
  };
  return { routes, snapshot, connectors, plugins, reject: value => { reject = value; } };
}
async function ledger(page, section) {
  await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Ledger', exact: true }).getByRole('radio', { name: section, exact: true }).click();
}
async function checked(control, value) {
  await control.page().waitForFunction(({ label, value }) => document.querySelector(`[role="switch"][aria-label="${label}"]`)?.getAttribute('aria-checked') === String(value), { label: await control.getAttribute('aria-label'), value });
}
async function shot(page, name) {
  if (!process.env.ELPIS_SHOTS) return;
  await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/${name}.png` });
}

test('LEDGER MCP switches persist first, middle and last rows; rejection restores saved state beside row', async () => {
  const s = state(), f = await fixture({ routes: s.routes });
  try {
    const { page } = f;
    await ledger(page, 'Connectors');
    await shot(page, 'connectors-light');
    for (const row of s.connectors) {
      const toggle = page.getByRole('switch', { name: `Use ${row.name}`, exact: true });
      await toggle.click(); await checked(toggle, false);
    }
    await page.reload(); await ledger(page, 'Connectors');
    for (const row of s.connectors) assert.equal(await page.getByRole('switch', { name: `Use ${row.name}`, exact: true }).getAttribute('aria-checked'), 'false');
    const toggle = page.getByRole('switch', { name: 'Use middle', exact: true });
    s.reject(true); await toggle.click();
    await page.locator('.customize-item').filter({ hasText: 'middle' }).getByRole('alert').filter({ hasText: 'Settings changed' }).waitFor();
    await checked(toggle, false);
    s.reject(false); await toggle.click(); await checked(toggle, true);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('LEDGER installed plugins switch, retain saved state on failure, reload and uninstall', async () => {
  const s = state(), f = await fixture({ routes: s.routes });
  try {
    const { page } = f;
    await ledger(page, 'Plugins');
    const toggle = page.getByRole('switch', { name: 'Use Docs', exact: true });
    await toggle.click(); await checked(toggle, false);
    await page.reload(); await ledger(page, 'Plugins'); await checked(toggle, false);
    s.reject(true); await toggle.click();
    await page.locator('.customize-item').filter({ hasText: 'Docs' }).getByRole('alert').filter({ hasText: 'Plugin change rejected' }).waitFor();
    await checked(toggle, false);
    s.reject(false); await toggle.click(); await checked(toggle, true);
    await page.getByRole('button', { name: 'Uninstall Docs', exact: true }).click();
    await page.getByText('No plugins installed', { exact: true }).waitFor();
    assert.equal(s.plugins.length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('LEDGER add marketplace, browse, search, install, installed state, remove; errors preserve source', async () => {
  const s = state(), f = await fixture({ routes: s.routes });
  try {
    const { page } = f;
    await ledger(page, 'Plugins');
    await page.getByRole('button', { name: 'Add plugins', exact: true }).click();
    const catalog = page.getByRole('region', { name: 'Plugin catalog', exact: true });
    await catalog.getByText('No marketplaces added', { exact: true }).waitFor();
    const source = catalog.getByRole('textbox', { name: 'Marketplace source', exact: true });
    await source.fill('anthropics/claude-plugins-official');
    s.reject(true); await catalog.getByRole('button', { name: 'Add marketplace', exact: true }).click();
    await catalog.getByRole('alert').filter({ hasText: 'Invalid marketplace source' }).waitFor();
    assert.equal(await source.inputValue(), 'anthropics/claude-plugins-official');
    s.reject(false); await catalog.getByRole('button', { name: 'Add marketplace', exact: true }).click();
    await catalog.getByText('Proof marketplace', { exact: true }).waitFor();
    const search = catalog.getByRole('textbox', { name: 'Search plugins', exact: true });
    await search.fill('missing'); await search.press('Enter');
    await catalog.getByText('No plugins match this search', { exact: true }).waitFor();
    await search.fill('review'); await search.press('Enter');
    await catalog.getByRole('button', { name: 'Install Review', exact: true }).click();
    await catalog.getByText('Installed', { exact: true }).waitFor();
    assert(s.plugins.some(item => item.id === 'review@proof'));
    await shot(page, 'plugins-light');
    await chooseTheme(page, 'dark');
    await shot(page, 'plugins-dark');
    await catalog.getByRole('button', { name: 'Remove Proof marketplace', exact: true }).click();
    await catalog.getByText('No marketplaces added', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('LEDGER loading and long lists stay inside their rows; unavailable writes explain why', async () => {
  const s = state();
  s.connectors.splice(0, s.connectors.length, ...Array.from({ length: 45 }, (_, i) => ({ name: `connector-${i}-${'long-name-'.repeat(16)}`, transport: 'stdio', enabled: true })));
  let release, writable = true;
  const waiting = new Promise(resolve => { release = resolve; });
  s.routes['/api/customize'] = async () => { await waiting; const value = s.snapshot(); if (!writable) value.connectors = { ...value.connectors, version: null, write: { available: false } }; return value; };
  const f = await fixture({ width: 950, routes: s.routes });
  try {
    const { page } = f;
    await ledger(page, 'Connectors');
    await page.getByText('Reading what Elpis has…', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Your connectors', exact: true }).count(), 0);
    release();
    const rows = page.getByRole('region', { name: 'Your connectors', exact: true });
    await rows.getByRole('switch').last().waitFor();
    assert.equal(await rows.getByRole('switch').count(), 45);
    for (const index of [0, 22, 44]) {
      const toggle = page.getByRole('switch', { name: `Use ${s.connectors[index].name}`, exact: true });
      await toggle.click(); await checked(toggle, false);
    }
    assert(await rows.locator('.customize-list').evaluate(list => list.scrollWidth <= list.clientWidth + 1), 'long names must not widen the list');
    await shot(page, 'connectors-long-light');
    await chooseTheme(page, 'dark'); await shot(page, 'connectors-long-dark');
    writable = false; await page.reload(); await ledger(page, 'Connectors');
    assert(await rows.getByRole('switch').first().isDisabled());
    await rows.getByRole('status').filter({ hasText: 'Reload Ledger to read writable MCP settings' }).first().waitFor();
    assert.deepEqual(f.errors, []);
  } finally { release(); await f.close(); }
});
