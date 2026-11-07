const { openSettings } = require('./controls.cjs');
// Every Settings page against a local adapter: page order, what each control writes, and narrow layouts. No runtime or model calls.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');

// ChatGPT's order (27 Oct): Personal, Integrations, Coding, Archived.

// The import preview carries only names and types; only an explicit, available selection is submitted.
test('Claude MCP import previews selections and handles a stale source without changing existing servers', async () => {
  const { fixture } = require('./parity-fixture.cjs');
  let conflict = false;
  const source = { version: 'm1', revision: 'r1', servers: [
    { name: 'shadcn', transport: 'stdio', status: 'available' },
    { name: 'rag', transport: 'stdio', status: 'exists' },
    { name: 'legacy', transport: 'unsupported', status: 'unsupported' },
  ] };
  const mcp = { version: 'm1', configPath: '/tmp/elpis/config.toml', write: { available: true }, servers: [{ name: 'rag', enabled: true, transport: 'stdio', command: 'rag', url: null, credentials: [] }] };
  const f = await fixture({ routes: {
    '/api/mcp': () => mcp,
    '/api/tools/rag': () => ({ stages: [], keys: { openrouter: false } }),
    '/api/mcp/import': (body: { names: string[] } | null) => body ? conflict ? { __http: 409, error: 'Settings changed. Preview the import again.' } : { imported: body.names.length } : source,
  } });
  try {
    const { page } = f; await openSettings(page, 'MCP servers');
    const panel = page.getByRole('tabpanel', { name: 'MCP servers' });
    await panel.getByRole('button', { name: 'Import from Claude Code' }).click();
    const preview = panel.getByRole('region', { name: 'Import Claude Code MCP servers' });
    const shadcn = preview.getByRole('checkbox', { name: /shadcn/ }); await shadcn.waitFor();
    assert.equal(await preview.getByRole('checkbox', { name: /rag/ }).isDisabled(), true);
    assert.equal(await preview.getByRole('checkbox', { name: /legacy/ }).isDisabled(), true);
    assert.equal(await preview.getByRole('button', { name: 'Import selected' }).isDisabled(), true);
    assert.equal(f.posts.filter((post: { path: string }) => post.path === '/api/mcp/import').length, 0);
    await shadcn.check(); await preview.getByRole('button', { name: 'Import selected' }).click();
    await panel.getByText('Imported 1 MCP server.', { exact: false }).waitFor();
    assert.deepEqual(f.posts.filter((post: { path: string }) => post.path === '/api/mcp/import').at(-1).body, { names: ['shadcn'], version: 'm1', revision: 'r1' });
    assert.equal(await panel.getByRole('region', { name: 'rag' }).count(), 1, 'existing server remains visible');
    conflict = true; await panel.getByRole('button', { name: 'Import from Claude Code' }).click();
    await preview.getByRole('checkbox', { name: /shadcn/ }).check(); await preview.getByRole('button', { name: 'Import selected' }).click();
    await panel.getByRole('alert').filter({ hasText: 'Settings changed' }).waitFor();
    assert.equal(await preview.count(), 0, 'a stale preview is discarded');
    assert.equal(await panel.getByRole('region', { name: 'rag' }).count(), 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Browser settings opens the native new tab and shares pinned websites with the browser store', async () => {
  const { fixture } = require('./parity-fixture.cjs');
  const key = 'elpis-browser-pins-v1', pin = { title: 'Docs', url: 'https://example.test/docs' };
  const f = await fixture({ storage: { [key]: JSON.stringify([pin]) } });
  try {
    const { page } = f; await f.open('chat-a'); await openSettings(page, 'Browser');
    let panel = page.getByRole('tabpanel', { name: 'Browser' });
    await panel.getByText('Docs', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Open browser', exact: true }).click();
    await page.waitForFunction(() => (window as Window & { __commands?: { action: string; url?: string }[] }).__commands?.some(command => command.action === 'new'));
    assert.deepEqual(await page.evaluate(() => (window as Window & { __commands?: { action: string; url?: string }[] }).__commands?.filter(command => command.action === 'new').at(-1)), { action: 'new' });
    await openSettings(page, 'Browser'); panel = page.getByRole('tabpanel', { name: 'Browser' });
    const row = panel.locator('[data-slot="settings-row"]').filter({ hasText: 'Docs' });
    await row.getByRole('button', { name: 'Open', exact: true }).click();
    await page.waitForFunction((url: string) => (window as Window & { __commands?: { action: string; url?: string }[] }).__commands?.some(command => command.action === 'new' && command.url === url), pin.url);
    await openSettings(page, 'Browser'); panel = page.getByRole('tabpanel', { name: 'Browser' });
    await panel.locator('[data-slot="settings-row"]').filter({ hasText: 'Docs' }).getByRole('button', { name: 'Unpin' }).click();
    assert.deepEqual(JSON.parse(await page.evaluate((key: string) => localStorage.getItem(key), key)), []);
    await page.reload(); await openSettings(page, 'Browser');
    assert.equal(await page.getByRole('tabpanel', { name: 'Browser' }).getByText('Docs', { exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
