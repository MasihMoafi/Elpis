const { openSettings, leaveSettings } = require('./controls.cts');
// Every Settings page against a local adapter: page order, what each control writes, and narrow layouts. No runtime or model calls.
const test = require('node:test'), assert = require('node:assert/strict');

// ChatGPT's order (27 Oct): Personal, Integrations, Coding, Archived.

// The import preview carries only names and types; only an explicit, available selection is submitted.
test('Claude MCP import previews selections and handles a stale source without changing existing servers', async () => {
  const { fixture } = require('./parity-fixture.cts');
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

// Masih, 13 Nov: "why is there a browser settings in the settings when it doesn't do anything?" Its controls only repeated
// the sidebar's pinned pages (open, unpin) and the side panel's browser, so the page is gone; the sidebar still does both.
test('Settings has no Browser page; a pinned website opens and unpins from the sidebar', async () => {
  const { fixture } = require('./parity-fixture.cts');
  const key = 'elpis-browser-pins-v1', pin = { title: 'Docs', url: 'https://example.test/docs' };
  const f = await fixture({ storage: { [key]: JSON.stringify([pin]) } });
  try {
    const { page } = f; await f.open('chat-a'); await openSettings(page);
    await page.getByRole('tab', { name: 'MCP servers', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Browser', exact: true }).count(), 0, 'no Browser page in Settings');
    await leaveSettings(page);
    const pins = page.getByRole('region', { name: 'Pinned browser pages' });
    await pins.getByRole('button', { name: /Docs/ }).first().click();
    await page.waitForFunction((url: string) => (window as Window & { __commands?: { action: string; url?: string }[] }).__commands?.some(command => command.action === 'new' && command.url === url), pin.url);
    await pins.getByRole('button', { name: 'Unpin Docs from sidebar', exact: true }).click();
    assert.deepEqual(JSON.parse(await page.evaluate((key: string) => localStorage.getItem(key), key)), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// Masih, 13 Nov: "why is the openrouter key section in RAG like that? it's broken and flickers my screen". rag's settings and
// its two model lists arrive at different times (rag's doctor is slow); the card took a new height as each one landed.
test('the RAG card settles once while its three reads arrive, and its OpenRouter key is one plain field', async () => {
  const { fixture } = require('./parity-fixture.cts');
  const later = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const fake = 'sk-or-v1-e31-fake-key-0000';
  let keySet = false;
  const mcp = () => ({ version: keySet ? 'm2' : 'm1', configPath: '/tmp/elpis/config.toml', write: { available: true }, servers: [{ name: 'rag', enabled: true, transport: 'stdio', command: 'rag-mcp', url: null, credentials: keySet ? [{ name: 'OPENROUTER_API_KEY', source: 'config', set: true }] : [] }] });
  const sol = { id: 'sol', model: 'sol', displayName: 'GPT-6.1-Sol', inputModalities: ['text', 'image'], supportedReasoningEfforts: [] };
  const f = await fixture({ routes: {
    '/api/mcp': (body: { action?: string; env?: Record<string, string> } | null) => { if (body?.action === 'credentials' && body.env?.OPENROUTER_API_KEY) keySet = true; return mcp(); },
    '/api/tools/rag': async () => { await later(300); return { stages: [{ stage: 'embedding', provider: 'openrouter', model: 'qwen/qwen3-embedding-8b', location: 'api' }, { stage: 'reranking', provider: null, model: 'off', location: 'local' }, { stage: 'generation', provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash', location: 'api' }], keys: { openrouter: keySet } }; },
    '/api/models': async (_body: unknown, url: URL) => {
      if (url.searchParams.get('provider') !== 'openrouter') return { data: [sol], nextCursor: null };
      // OpenRouter's reranker list fails late, as when its catalogue is slow: its notice is one more change of height.
      if (url.searchParams.get('outputModality') === 'rerank') { await later(1500); return { __http: 502, error: 'OpenRouter did not answer' }; }
      await later(900); return { data: [{ id: 'deepseek/deepseek-v4.1-flash', model: 'deepseek/deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash' }] };
    },
  } });
  try {
    const { page } = f; await openSettings(page, 'MCP servers');
    const card = page.locator('section.mcp-server[data-name="rag"]'); await card.waitFor();
    await page.evaluate(() => {
      const w = window as unknown as { __heights: number[] }, el = document.querySelector('section.mcp-server[data-name="rag"]')!;
      w.__heights = []; const tick = () => { w.__heights.push(Math.round(el.getBoundingClientRect().height)); requestAnimationFrame(tick); }; tick();
    });
    const from = f.requests.length;
    await page.waitForTimeout(2500);
    const heights: number[] = await page.evaluate(() => (window as unknown as { __heights: number[] }).__heights);
    const changes = heights.filter((height, i) => i > 0 && height !== heights[i - 1]).length;
    console.log('rag card heights', heights.filter((height, i) => height !== heights[i - 1]).join(' → '));
    assert.ok(changes <= 1,`the card changes height once, from reading to read (heights ${[...new Set(heights)].join(', ')})`);
    const asked = f.requests.slice(from).map((request: { path: string }) => request.path);
    assert.equal(asked.filter((path: string) => path === '/api/tools/rag').length <= 1, true, 'rag is read once');
    assert.equal(asked.filter((path: string) => path === '/api/mcp').length, 0, 'the server list is not read again');
    await card.getByRole('combobox', { name: 'RAG answer model' }).waitFor();
    // One field for the key, its state in words, the key never on screen.
    const keys = card.locator('input[type="password"]');
    assert.equal(await keys.count(), 1, 'one key field');
    assert.match(await card.innerText(), /OpenRouter key\s*Not saved/);
    assert.doesNotMatch(await card.innerText(), /as rag sees it|OPENROUTER_API_KEY · /, 'the key state is said once');
    await keys.fill(fake);
    await card.getByRole('button', { name: 'Save key', exact: true }).click();
    await card.getByRole('status').filter({ hasText: 'Key saved.' }).waitFor();
    assert.match(await card.innerText(), /OpenRouter key\s*Saved/);
    assert.equal(await keys.inputValue(), '');
    assert.equal((await page.content()).includes(fake), false, 'the key is never shown');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
