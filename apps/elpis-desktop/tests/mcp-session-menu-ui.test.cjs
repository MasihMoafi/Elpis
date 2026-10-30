const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const { fixture } = require('./parity-fixture.cjs');

const renderer = process.env.ELPIS_MCP_UI_RENDERER || path.resolve(__dirname, '../out');
const LONG_NAME = 'M'.repeat(64);
const SERVERS = [
  { name: 'mcp-alpha', enabled: true, transport: 'stdio', command: 'mcp-alpha', url: null },
  { name: 'mcp-beta', enabled: true, transport: 'http', command: null, url: 'https://mcp.invalid/beta' },
  { name: LONG_NAME, enabled: true, transport: 'stdio', command: 'mcp-long', url: null },
  { name: 'mcp-disabled', enabled: false, transport: 'stdio', command: 'mcp-disabled', url: null },
];
const THREAD_ID = 'mcp-ui-created';

function threadRoutes(created, turns) {
  return {
    '/api/threads': body => {
      if (!body) return { data: [], nextCursor: null };
      created.push(body);
      return { thread: { id: THREAD_ID, cwd: body.cwd || '/tmp/parity-fixture', model: 'sol', provider: 'openai' }, permissions: body.permissions };
    },
    [`/api/threads/${THREAD_ID}/turns`]: body => {
      turns.push(body);
      return { turn: { id: 'mcp-ui-turn' } };
    },
  };
}

function item(page, name) {
  return page.getByRole('menuitemcheckbox').filter({ hasText: name });
}

async function checked(row, expected) {
  await row.waitFor({ state: 'visible' });
  assert.equal(await row.getAttribute('aria-checked'), String(expected));
}

async function screenshot(page, name) {
  const directory = process.env.ELPIS_MCP_UI_SHOTS;
  if (!directory) return;
  await fs.mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: true });
}

async function setTheme(page, theme) {
  await page.emulateMedia({ colorScheme: theme });
  await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark');
}

async function assertComposerFits(page, label, expectedStatus = false) {
  const result = await page.locator('.composer-controls').evaluate(root => {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const visible = el => {
      const style = getComputedStyle(el), r = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
    };
    const children = [...root.children].filter(visible).map(el => ({
      label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 60),
      rect: rect(el),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    const controls = [...root.querySelectorAll('button, [role="combobox"], [role="status"]')].filter(visible).map(el => ({
      label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 60),
      rect: rect(el),
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      status: el.getAttribute('role') === 'status',
    }));
    const status = controls.find(control => control.status) || null;
    const r = rect(root);
    const overlaps = items => {
      const result = [];
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i].rect, b = items[j].rect;
        if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) result.push([items[i].label, items[j].label]);
      }
      return result;
    };
    return { root: r, scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, children, controls, overlaps: overlaps(children), controlOverlaps: overlaps(controls), status, viewportWidth: innerWidth };
  });
  const problems = [];
  if (result.root.left < -1 || result.root.right > result.viewportWidth + 1) problems.push(`${label}: composer controls leave the viewport: ${JSON.stringify(result)}`);
  if (result.scrollWidth > result.clientWidth + 1) problems.push(`${label}: composer controls overflow: ${JSON.stringify(result)}`);
  if (result.overlaps.length) problems.push(`${label}: composer controls overlap: ${JSON.stringify(result.overlaps)}`);
  if (result.controlOverlaps.length) problems.push(`${label}: composer buttons/status overlap: ${JSON.stringify(result.controlOverlaps)}`);
  for (const child of result.children) {
    if (child.rect.left < result.root.left - 1 || child.rect.right > result.root.right + 1) problems.push(`${label}: ${child.label} leaves its control row: ${JSON.stringify(child)}`);
    if (child.scrollWidth > child.clientWidth + 1) problems.push(`${label}: ${child.label} clips its label: ${JSON.stringify(child)}`);
  }
  if (Boolean(result.status) !== expectedStatus) problems.push(`${label}: expected status presence ${expectedStatus}: ${JSON.stringify(result)}`);
  if (result.status && (result.status.rect.left < result.root.left - 1 || result.status.rect.right > result.root.right + 1 || result.status.scrollWidth > result.status.clientWidth + 1)) {
    problems.push(`${label}: MCP error status leaves or clips within the composer: ${JSON.stringify(result.status)}`);
  }
  for (const control of result.controls) {
    if (control.scrollWidth > control.clientWidth + 1) problems.push(`${label}: ${control.label} clips content: ${JSON.stringify(control)}`);
  }
  return problems;
}

async function assertMenuFits(page, width, theme) {
  const trigger = page.getByRole('button', { name: 'Choose MCP servers for this chat' });
  await trigger.click();
  const menu = page.getByRole('menu');
  await menu.waitFor({ state: 'visible' });
  const report = await menu.evaluate(root => {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const name = [...root.querySelectorAll('[role="menuitemcheckbox"] span')].find(el => el.textContent === 'M'.repeat(64));
    const range = document.createRange();
    range.selectNodeContents(name);
    const textRects = [...range.getClientRects()].map(r => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom }));
    const row = name.closest('[role="menuitemcheckbox"]');
    const style = getComputedStyle(name);
    return {
      menu: rect(root),
      row: rect(row),
      label: rect(name),
      labelScrollWidth: name.scrollWidth,
      labelClientWidth: name.clientWidth,
      fontSize: parseFloat(style.fontSize),
      lineHeight: parseFloat(style.lineHeight),
      textRight: Math.max(...textRects.map(r => r.right)),
      textFragments: textRects.length,
      viewport: { width: innerWidth, height: innerHeight },
    };
  });
  await screenshot(page, `mcp-menu-${width}-${theme}`);
  const problems = [];
  if (report.menu.left < -1 || report.menu.right > report.viewport.width + 1) problems.push(`${width}px ${theme}: menu is outside viewport: ${JSON.stringify(report)}`);
  if (report.menu.top < -1 || report.menu.bottom > report.viewport.height + 1) problems.push(`${width}px ${theme}: menu is outside viewport: ${JSON.stringify(report)}`);
  if (report.row.left < report.menu.left - 1 || report.row.right > report.menu.right + 1) problems.push(`${width}px ${theme}: option row leaves menu: ${JSON.stringify(report)}`);
  if (report.textRight > report.row.right + 1) problems.push(`${width}px ${theme}: 64-character name overflows its option: ${JSON.stringify(report)}`);
  if (report.labelScrollWidth > report.labelClientWidth + 1) problems.push(`${width}px ${theme}: 64-character name is clipped: ${JSON.stringify(report)}`);
  if (report.fontSize < 12 || report.lineHeight < 14) problems.push(`${width}px ${theme}: option text is too small to read: ${JSON.stringify(report)}`);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  problems.push(...await assertComposerFits(page, `${width}px ${theme} idle composer`));
  return problems;
}

async function assertSiblingMenuFits(page, triggerName, label, theme) {
  await page.getByRole('button', { name: triggerName }).click();
  const menu = page.getByRole('menu');
  await menu.waitFor({ state: 'visible' });
  const report = await menu.evaluate(root => {
    const rect = el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const items = [...root.querySelectorAll('[role^="menuitem"]')].map(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const fragments = [...range.getClientRects()];
      return { rect: rect(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, fontSize: parseFloat(getComputedStyle(el).fontSize), textRight: fragments.length ? Math.max(...fragments.map(r => r.right)) : 0 };
    });
    return { menu: rect(root), items, viewport: { width: innerWidth, height: innerHeight } };
  });
  await screenshot(page, `shared-${label}-320-${theme}`);
  const problems = [];
  if (report.menu.left < -1 || report.menu.right > report.viewport.width + 1 || report.menu.top < -1 || report.menu.bottom > report.viewport.height + 1) problems.push(`320px ${theme} ${label} menu leaves viewport: ${JSON.stringify(report)}`);
  for (const item of report.items) {
    if (item.rect.left < report.menu.left - 1 || item.rect.right > report.menu.right + 1) problems.push(`320px ${theme} ${label} item leaves menu: ${JSON.stringify(item)}`);
    if (item.scrollWidth > item.clientWidth + 1 || item.textRight > item.rect.right + 1) problems.push(`320px ${theme} ${label} item clips text: ${JSON.stringify(item)}`);
    if (item.fontSize < 12) problems.push(`320px ${theme} ${label} item text is too small: ${JSON.stringify(item)}`);
  }
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  return problems;
}

test('MCP choices render, stay draft-scoped, and reach thread creation', async t => {
  const created = [], turns = [], mcpRequests = [];
  const routes = {
    ...threadRoutes(created, turns),
    '/api/mcp': (_body, url) => {
      mcpRequests.push(`${url.pathname}${url.search}`);
      return { servers: SERVERS };
    },
  };
  const f = await fixture({ staticDir: renderer, threads: [], readyThreadId: null, width: 1280, height: 800, routes });
  t.after(() => f.close());

  const page = f.page;
  const geometryProblems = [];
  const behaviorProblems = [];
  await page.getByRole('button', { name: 'Choose MCP servers for this chat' }).waitFor({ state: 'visible' });
  for (const theme of ['light', 'dark']) {
    for (const width of [320, 400, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await setTheme(page, theme);
      geometryProblems.push(...await assertMenuFits(page, width, theme));
    }
  }
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 320, height: 800 });
    await setTheme(page, theme);
    geometryProblems.push(...await assertSiblingMenuFits(page, 'Change permissions', 'permissions', theme));
    geometryProblems.push(...await assertSiblingMenuFits(page, 'Add files and more', 'features', theme));
  }
  assert.ok(mcpRequests.some(request => request.startsWith('/api/mcp')));

  await page.setViewportSize({ width: 1280, height: 800 });
  await setTheme(page, 'light');
  await page.getByRole('button', { name: 'Choose MCP servers for this chat' }).click();
  await checked(item(page, 'mcp-alpha'), true);
  await checked(item(page, 'mcp-beta'), true);
  await checked(item(page, LONG_NAME), true);
  const disabled = item(page, 'mcp-disabled');
  assert.equal(await disabled.getAttribute('aria-disabled'), 'true');
  await disabled.evaluate(row => row.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await checked(disabled, false);

  const originalTab = page.getByRole('tab').first();
  const longOption = item(page, LONG_NAME);
  await longOption.focus();
  await page.keyboard.press('Space');
  const menuStayedOpen = await page.getByRole('menu').isVisible().catch(() => false);
  if (!menuStayedOpen) behaviorProblems.push('Space closed the multi-select menu.');
  if (!menuStayedOpen) await page.getByRole('button', { name: 'Choose MCP servers for this chat' }).click();
  const checkedAfterSpace = await longOption.getAttribute('aria-checked');
  if (checkedAfterSpace !== 'false') behaviorProblems.push(`Space did not deselect the focused server (aria-checked=${checkedAfterSpace}).`);

  await page.getByRole('button', { name: 'New chat tab', exact: true }).click();
  const secondTab = page.getByRole('tab').nth(1);
  await secondTab.waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Choose MCP servers for this chat' }).click();
  await checked(item(page, 'mcp-alpha'), true);
  await checked(item(page, 'mcp-beta'), true);
  await checked(item(page, LONG_NAME), true);
  await item(page, 'mcp-beta').click();
  await checked(item(page, 'mcp-beta'), false);
  await page.keyboard.press('Escape');
  await f.composer.fill('Keep this as the second draft');

  await originalTab.click();
  await page.getByRole('button', { name: 'Choose MCP servers for this chat' }).click();
  await checked(item(page, 'mcp-alpha'), true);
  await checked(item(page, 'mcp-beta'), true);
  await checked(item(page, LONG_NAME), false);
  await page.keyboard.press('Escape');
  await f.composer.fill('Create this selected MCP chat');
  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/threads');
  const turnResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/threads/${THREAD_ID}/turns`);
  await page.getByRole('button', { name: 'Send message' }).click();
  await Promise.all([createdResponse, turnResponse]);
  assert.equal(created.length, 1, 'a typed message must create exactly one thread');
  assert.deepEqual([...created[0].mcpServers].sort(), ['mcp-alpha', 'mcp-beta']);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Create this selected MCP chat');

  await page.getByRole('tab').nth(1).click();
  assert.equal(await f.composer.inputValue(), 'Keep this as the second draft');
  await page.getByRole('button', { name: 'Choose MCP servers for this chat' }).click();
  await checked(item(page, 'mcp-alpha'), true);
  await checked(item(page, 'mcp-beta'), false);
  await checked(item(page, LONG_NAME), true);
  assert.deepEqual(f.errors, []);
  assert.deepEqual(behaviorProblems, []);
  assert.deepEqual(geometryProblems, []);
});

test('an unavailable catalog preserves a typed draft and permits the configured-default send at 320px', async t => {
  const created = [], turns = [];
  let rejectCatalog;
  let catalogRequestedResolve;
  const catalogRequested = new Promise(resolve => { catalogRequestedResolve = resolve; });
  const catalogReply = new Promise(resolve => { rejectCatalog = resolve; });
  const routes = {
    ...threadRoutes(created, turns),
    '/api/mcp': async () => {
      catalogRequestedResolve();
      await catalogReply;
      return { __http: 503, error: 'fixture MCP catalog failure' };
    },
  };
  const f = await fixture({ staticDir: renderer, threads: [], readyThreadId: null, width: 320, height: 800, routes });
  t.after(() => f.close());
  const page = f.page;

  await catalogRequested;
  await f.composer.fill('Send despite the optional MCP catalog error');
  rejectCatalog();
  const status = page.getByRole('status', { name: /MCP choices unavailable/ });
  await status.waitFor({ state: 'visible' });
  assert.equal(await f.composer.inputValue(), 'Send despite the optional MCP catalog error');
  assert.equal(await page.getByRole('button', { name: 'Send message' }).isEnabled(), true);

  const geometryProblems = [];
  for (const theme of ['light', 'dark']) {
    await setTheme(page, theme);
    geometryProblems.push(...await assertComposerFits(page, `320px ${theme} catalog-error composer`, true));
    await screenshot(page, `mcp-error-320-${theme}`);
  }

  const createdResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/threads');
  const turnResponse = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/threads/${THREAD_ID}/turns`);
  await page.getByRole('button', { name: 'Send message' }).click();
  await Promise.all([createdResponse, turnResponse]);
  assert.equal(created.length, 1, 'the optional MCP catalog must not block normal chat creation');
  assert.equal(Object.hasOwn(created[0], 'mcpServers'), false, 'without an explicit choice the create request must keep configured defaults');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Send despite the optional MCP catalog error');
  assert.deepEqual(f.errors, []);
  assert.deepEqual(geometryProblems, []);
});

test('the catalog request carries the active project cwd', async t => {
  const requested = [];
  const project = { id: 'fixture-project', name: 'Fixture project', cwd: '/tmp/mcp-ui-project' };
  const f = await fixture({
    staticDir: renderer,
    threads: [],
    readyThreadId: null,
    width: 1280,
    height: 800,
    storage: { 'elpis-projects-v1': JSON.stringify({ projects: [project], selectedId: null }) },
    routes: {
      '/api/threads': () => ({ data: [], nextCursor: null }),
      '/api/mcp': (_body, url) => {
        requested.push(`${url.pathname}${url.search}`);
        return { servers: SERVERS };
      },
    },
  });
  t.after(() => f.close());

  const projectCatalog = f.page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/mcp' && url.searchParams.get('cwd') === project.cwd;
  });
  await f.page.getByRole('button', { name: 'Start new chat in Fixture project' }).click();
  await projectCatalog;
  assert.ok(requested.includes('/api/mcp?cwd=%2Ftmp%2Fmcp-ui-project'), `project catalog request missing cwd: ${requested.join(', ')}`);
  assert.deepEqual(f.errors, []);
});
