const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

function state(login = 'octocat') {
  const github = { name: 'GitHub', transport: 'gh', enabled: false, login }, writes = [];
  const reply = () => ({ skills: { data: [] }, plugins: { data: [] }, connectors: { data: [{ ...github }, { name: 'rag', enabled: true, transport: 'stdio' }] } });
  return { github, writes, routes: {
    '/api/customize': reply,
    '/api/customize/github': body => { writes.push(body); github.enabled = body.enabled; return reply(); },
  } };
}
async function connectors(page) {
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Customize', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Customize', exact: true }).getByRole('radio', { name: 'Connectors', exact: true }).click();
  return page.getByRole('region', { name: 'Your connectors', exact: true });
}

test('mouse and keyboard toggle control the instructions sent by the real bridge for new chats', async () => {
  const { DesktopClient } = await import('../bridge/client.mjs');
  const { createGithubConnector } = await import('../bridge/github-connector.mjs');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-github-ui-'));
  const socket = new EventEmitter(), starts = [], gh = [], threads = [{ id: 'chat-a', name: 'Fixture chat', cwd: '/tmp', status: { type: 'idle' } }];
  socket.close = () => {};
  socket.send = raw => {
    const { id, method, params } = JSON.parse(raw);
    let result = { 'skills/list': { data: [] }, 'plugin/installed': { marketplaces: [] },
      'config/read': { config: { model: 'sol', model_provider: 'openai', mcp_servers: {} } },
      'model/list': { data: [{ id: 'sol', model: 'sol', displayName: 'Sol' }] } }[method];
    if (method === 'thread/start') {
      starts.push(params);
      const thread = { id: `00000000-0000-0000-0000-00000000000${starts.length}`, name: `New ${starts.length}`, model: 'sol', cwd: '/tmp', status: { type: 'idle' } };
      threads.push(thread); result = { thread };
    }
    assert.ok(result, `unexpected RPC ${method}`);
    queueMicrotask(() => socket.emit('message', JSON.stringify({ id, result })));
  };
  const client = new DesktopClient(socket, { rewindHome: home, githubConnector: createGithubConnector({ home,
    run: async (...args) => { gh.push(args); return 'planted-login'; } }) });
  await client.models();
  const routes = { '/api/customize': () => client.customize(), '/api/customize/github': body => client.setGithubConnector(body),
    '/api/threads': body => body ? client.createThread(body) : { data: threads, nextCursor: null } };
  for (let n = 1; n <= 2; n++) {
    const id = `00000000-0000-0000-0000-00000000000${n}`;
    routes[`/api/threads/${id}/turns`] = () => ({ turn: { id: `turn-${n}` } });
    routes[`/api/threads/${id}`] = () => ({ thread: threads.find(item => item.id === id), data: [], nextCursor: null });
    routes[`/api/threads/${id}/resume`] = () => ({ thread: threads.find(item => item.id === id), activeTurnId: null });
  }
  const f = await fixture({ routes });
  try {
    for (const enabled of [true, false]) {
      const view = await connectors(f.page), toggle = view.getByRole('switch', { name: 'Use GitHub', exact: true });
      if (enabled) await toggle.click(); else { await toggle.focus(); await f.page.keyboard.press('Space'); }
      await f.page.waitForFunction(on => document.querySelector('[aria-label="Use GitHub"]')?.getAttribute('aria-checked') === String(on), enabled);
      await f.page.getByRole('button', { name: 'New chat', exact: true }).click();
      await f.composer.fill(enabled ? 'Use GitHub.' : 'An ordinary task.');
      const before = starts.length;
      await Promise.all([f.page.waitForResponse(response => response.url().endsWith('/turns') && response.request().method() === 'POST'), f.composer.press('Enter')]);
      assert.equal(starts.length, before + 1);
      if (enabled) assert.match(starts.at(-1).developerInstructions, /gh is signed in as planted-login.*GitHub work/);
      else assert.equal(starts.at(-1).developerInstructions, undefined);
    }
    assert.ok(gh.length > 0);
    assert.ok(gh.every(([command, args]) => command === 'gh' && args[0] === 'api'));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); client.close(); }
});

test('GitHub is beside MCP connectors; the switch works by mouse and keyboard and survives reload', async () => {
  const s = state(), f = await fixture({ routes: s.routes });
  try {
    let view = await connectors(f.page);
    assert.deepEqual(await view.locator('.customize-name').allInnerTexts(), ['GitHub', 'rag']);
    await view.getByText('Connected as octocat', { exact: true }).waitFor();
    let toggle = view.getByRole('switch', { name: 'Use GitHub', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.click();
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Use GitHub"]')?.getAttribute('aria-checked') === 'true');
    await f.page.reload();
    view = await connectors(f.page); toggle = view.getByRole('switch', { name: 'Use GitHub', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.focus(); await f.page.keyboard.press('Space');
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Use GitHub"]')?.getAttribute('aria-checked') === 'false');
    assert.deepEqual(s.writes, [{ enabled: true }, { enabled: false }]);
    assert.deepEqual(await f.page.evaluate(() => window.__terminal.input), []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Connect opens a side terminal and types only gh auth login --web once; returning refreshes the login', async () => {
  const s = state(null), f = await fixture({ routes: s.routes });
  try {
    const view = await connectors(f.page);
    await view.getByText('Not connected', { exact: true }).waitFor();
    await view.getByRole('button', { name: 'Connect', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await f.page.waitForFunction(() => window.__terminal.input.some(([, text]) => text.includes('gh auth login --web')));
    const calls = await f.page.evaluate(() => window.__terminal);
    assert.equal(calls.open.length, 1);
    assert.deepEqual(calls.input, [[calls.open[0][0], '\x05\x15gh auth login --web\r']]);
    await f.page.getByRole('region', { name: 'Terminal', exact: true }).waitFor();
    assert.deepEqual(s.writes, [{ enabled: true }]);
    s.github.login = 'signed-in';
    const again = await connectors(f.page);
    await again.getByText('Connected as signed-in', { exact: true }).waitFor();
    assert.equal(await again.getByRole('switch', { name: 'Use GitHub', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal((await f.page.evaluate(() => window.__terminal.input)).length, 1);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('failed saves and browser-only Connect show a useful error without starting login', async () => {
  const s = state(), f = await fixture({ routes: { ...s.routes, '/api/customize/github': () => ({ __http: 500, error: 'Could not save GitHub preference.' }) } });
  try {
    const view = await connectors(f.page);
    await view.getByRole('switch', { name: 'Use GitHub', exact: true }).click();
    await f.page.getByText('Could not save GitHub preference.', { exact: true }).waitFor();
    assert.equal(await view.getByRole('switch', { name: 'Use GitHub', exact: true }).getAttribute('aria-checked'), 'false');
    assert.deepEqual(await f.page.evaluate(() => window.__terminal.input), []);
  } finally { await f.close(); }
  const browser = await fixture({ desktop: false, routes: state(null).routes });
  try {
    const view = await connectors(browser.page);
    await view.getByRole('button', { name: 'Connect', exact: true }).click();
    await browser.page.getByText('Connect GitHub in the Elpis desktop app.', { exact: true }).waitFor();
    assert.equal(browser.posts.some(item => item.path === '/api/customize/github'), false);
  } finally { await browser.close(); }
});

test('GitHub can still be switched off after its gh login expires', async () => {
  const s = state(null); s.github.enabled = true;
  const f = await fixture({ routes: s.routes });
  try {
    const view = await connectors(f.page), toggle = view.getByRole('switch', { name: 'Use GitHub', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    await toggle.click();
    await f.page.waitForFunction(() => document.querySelector('[aria-label="Use GitHub"]')?.getAttribute('aria-checked') === 'false');
    await view.getByRole('button', { name: 'Connect', exact: true }).waitFor();
    assert.deepEqual(await f.page.evaluate(() => window.__terminal.input), []);
  } finally { await f.close(); }
});

for (const [width, height] of [[1280, 800], [900, 700]]) for (const theme of ['light', 'dark']) {
  test(`GitHub connected and disconnected fit ${width}×${height} ${theme}`, async () => {
    const s = state(), f = await fixture({ width, height, colorScheme: theme, routes: s.routes });
    try {
      await f.page.waitForFunction(dark => document.querySelector('.app-shell').classList.contains('dark') === dark, theme === 'dark');
      await connectors(f.page);
      for (const connected of [true, false]) {
        s.github.login = connected ? 'octocat' : null;
        await f.page.getByRole('button', { name: 'Refresh connectors', exact: true }).click();
        await f.page.getByText(connected ? 'Connected as octocat' : 'Not connected', { exact: true }).waitFor();
        await f.page.evaluate(async () => { await Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))); });
        await assertUiFit(f.page.locator('.customize'), `GitHub ${connected ? 'connected' : 'disconnected'}`);
        if (process.env.ELPIS_SHOTS) {
          await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
          await f.page.screenshot({ path: `${process.env.ELPIS_SHOTS}/github-${width}-${theme}-${connected ? 'connected' : 'disconnected'}.png` });
        }
      }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  });
}
