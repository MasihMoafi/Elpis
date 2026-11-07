// Regression only: real-engine acceptance is ledger-engine.runtime.mts and ledger-app.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
type Locator = { page(): Page; getAttribute(name: string): Promise<string | null> };
type Page = { locator(selector: string): { getByRole(role: string, options: object): { click(): Promise<void> } }; getByRole(role: string, options: object): { getByRole(role: string, options: object): { click(): Promise<void> } }; waitForFunction(fn: (arg: { label: string | null; value: boolean }) => boolean, arg: { label: string | null; value: boolean }): Promise<unknown>; screenshot(options: { path: string }): Promise<unknown> };
type Body = { version: string; action: string; name: string; id: string; enabled: boolean };

const write = { version: 'ledger-v1', write: { available: true } };
function state() {
  const connectors = ['alpha', 'middle', 'omega'].map((name, i) => ({ name, transport: i === 1 ? 'http' : 'stdio', enabled: true }));
  const plugins = [{ id: 'docs@proof', name: 'Docs', description: 'Write documentation', marketplace: 'proof', enabled: true }];
  const available = { id: 'review@proof', pluginName: 'review', name: 'Review', description: 'Review code', marketplace: 'proof', marketplaceName: 'proof', marketplacePath: '/catalog/.claude-plugin/marketplace.json', installed: false, enabled: false, installable: true, reason: null };
  let markets: { name: string; displayName: string; path: string }[] = [], reject = false;
  const snapshot = () => ({ skills: { data: [] }, plugins: { data: plugins, ...write }, connectors: { data: connectors, ...write } });
  const catalog = () => ({ marketplaces: markets, plugins: markets.length ? [{ ...available }] : [], errors: [], nextCursor: null });
  const routes = {
    '/api/customize': snapshot,
    '/api/mcp': (body: Body) => {
      if (reject) return { __http: 409, error: 'Settings changed in another client' };
      assert.equal(body.version, 'ledger-v1'); assert.equal(body.action, 'enable');
      const connector = connectors.find(item => item.name === body.name); if (!connector) throw new Error('Unknown connector'); connector.enabled = body.enabled;
      return { servers: connectors, ...write };
    },
    '/api/customize/plugin': (body: Body) => {
      if (reject) return { __http: 503, error: 'Plugin change rejected' };
      if (body.action === 'enable') { assert.equal(body.version, 'ledger-v1'); const plugin = plugins.find(item => item.id === body.id); if (!plugin) throw new Error('Unknown plugin'); plugin.enabled = body.enabled; }
      if (body.action === 'uninstall') plugins.splice(plugins.findIndex(item => item.id === body.id), 1);
      if (body.action === 'install') { available.installed = true; plugins.push({ ...available, enabled: true }); }
      return { ...snapshot(), appsNeedingAuth: [] };
    },
    '/api/customize/plugins': (_body: unknown, url: URL) => {
      const value = catalog();
      const search = url.searchParams.get('search'); if (search && !'review'.includes(search.toLowerCase())) value.plugins = [];
      return value;
    },
    '/api/customize/marketplace': (body: Body) => {
      if (reject) return { __http: 400, error: 'Invalid marketplace source' };
      if (body.action === 'add') markets = [{ name: 'proof', displayName: 'Proof marketplace', path: '/catalog/.claude-plugin/marketplace.json' }];
      else markets = [];
      return {};
    },
  };
  return { routes, snapshot, connectors, plugins, reject: (value: boolean) => { reject = value; } };
}
async function ledger(page: Page, section: string) {
  await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Customize', exact: true }).getByRole('radio', { name: section, exact: true }).click();
}
async function checked(control: Locator, value: boolean) {
  await control.page().waitForFunction(({ label, value }) => document.querySelector(`[role="switch"][aria-label="${label}"]`)?.getAttribute('aria-checked') === String(value), { label: await control.getAttribute('aria-label'), value });
}
async function shot(page: Page, name: string) {
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
