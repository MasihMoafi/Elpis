const { guardDesktopStore, leaveSettings, sidebar, openSettings } = require('./controls.cjs');
// Real exported renderer with synthetic HTTP/SSE; no engine or provider calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const output = process.env.ELPIS_AVAILABILITY_TEST_OUT || path.join(__dirname, '../out');
async function eventually(check) {
  const deadline = Date.now() + 4000;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 40)); } }
}
const sol = { id: 'sol', model: 'sol', displayName: 'Sol' };
const latest = { id: 'latest-model', model: 'latest-model', displayName: 'Latest model' };

async function fixture(t, { modelFailure = false, holdModels = false, descendantCount = 0, archivedDescendantCount = 0, descendantFailure = false, descendantCursor = null } = {}) {
  const clients = new Set(), loveClients = new Set(), posts = [], requests = [], errors = [], held = [];
  const archived = new Set(), deleted = new Set();
  const threads = ['a', 'b', 'c'].map(id => ({ id, name: `Availability chat ${id.toUpperCase()}`, model: 'sol', modelProvider: 'openai', cwd: '/tmp/availability-fixture', parentThreadId: id === 'c' ? 'a' : null, status: { type: 'idle' }, desktopAccess: { mode: 'direct', writable: true } }));
  const archivedDescendantIds = Array.from({ length: archivedDescendantCount }, (_, index) => `archived-unloaded-${index + 1}`);
  const descendantIds = [...Array.from({ length: descendantCount }, (_, index) => `unloaded-${index + 1}`), ...archivedDescendantIds];
  for (const id of archivedDescendantIds) archived.add(id);
  threads.push(...descendantIds.map(id => ({ ...threads[2], id, name: `Unloaded child ${id.slice(9)}` })));
  const settings = { background: {}, smartPrune: { explicitOverride: {} }, memory: {}, version: 'fixture-v1', main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'alternate-local', displayName: 'Alternate local' }], write: { available: true } };
  const control = { modelFailure, holdModels, modelReads: 0, descendantReads: [] };
  const emit = (type, data) => { for (const client of clients) client.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
  function external(method, id) {
    for (const affected of [...threads.filter(thread => thread.parentThreadId === id).map(thread => thread.id), id]) {
      if (method === 'thread/archived') archived.add(affected);
      if (method === 'thread/deleted') deleted.add(affected);
      emit('message', { method, params: { threadId: affected } });
    }
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'), pathname = url.pathname;
    if (pathname.startsWith('/api/')) requests.push({ method: req.method, path: pathname });
    const json = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    if (pathname === '/api/events') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': connected\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (/^\/api\/love-spot\/(?:talk\/)?events$/.test(pathname)) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write(': fixture\n\n'); loveClients.add(res); req.on('close', () => loveClients.delete(res)); return; }
    if (req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {}; if (!(pathname.endsWith('/rewind') && body.action === 'status')) posts.push({ path: pathname, body });
      const id = pathname.split('/')[3], thread = threads.find(item => item.id === id);
      if (pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
      if (pathname.endsWith('/rewind') && body.action === 'status') return json({});
      if (pathname.endsWith('/archive')) { archived.add(id); for (const child of threads.filter(thread => thread.parentThreadId === id)) archived.add(child.id); return json({ archived: true }); }
      if (pathname.endsWith('/unarchive')) { archived.delete(id); return json({ thread }); }
      if (pathname.endsWith('/delete')) { deleted.add(id); const children = threads.filter(item => item.parentThreadId === id).map(item => item.id); for (const child of children) deleted.add(child); return json({ deleted: true, alsoDeleted: [] }); }
      errors.push(`Unexpected POST ${pathname}`); return json({ error: 'Unexpected fixture mutation' }, 400);
    }
    if (pathname === '/api/health') return json({ connected: true });
    if (pathname === '/api/voice') return json({ available: false });
    if (pathname === '/api/personal') return json({ path: '/tmp/availability-fixture/skills/personal/SKILL.md', showTip: false });
    if (pathname === '/api/improvements') return json({ data: [] });
    if (pathname === '/api/models') {
      if (url.searchParams.get('provider') === 'alternate-local') return json({ data: [{ id: 'local-choice', model: 'local-choice', displayName: 'Local choice' }], nextCursor: null });
      control.modelReads++;
      res.setHeader('X-Fixture-Model-Read', String(control.modelReads));
      if (control.holdModels) { let done = false; held.push((data, status = 200) => { if (!done) { done = true; json(data, status); } }); return; }
      return control.modelFailure ? json({ error: 'Fixture sign-in required for models' }, 503) : json({ data: [sol, latest], nextCursor: null });
    }
    if (pathname === '/api/settings') return json(settings);
    // Elpis's switches under the message box (components/elpis-features.tsx), read on every screen.
    if (pathname === '/api/context/switches') return json({ version: 'fixture-v1', write: { available: false, reason: 'Fixture' }, smartPrune: true, subagents: true, rag: null });
    if (pathname === '/api/providers') return json({ openai: { auth: { state: 'signedIn', method: 'chatgpt' }, usage: [], usageError: null }, claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [], local: [] });
    if (pathname === '/api/providers/settings') return json({ version: 'fixture-v1', write: { available: false }, managed: {}, providers: [] });
    if (pathname === '/api/mcp') return json({ version: 'fixture-v1', write: { available: false }, servers: [] });
    if (pathname === '/api/tools/transcription') return json({ available: false });
    if (pathname === '/api/threads') {
      const ancestor = url.searchParams.get('ancestorThreadId'), includeArchived = url.searchParams.get('archived') === 'true';
      const data = threads.filter(thread => !deleted.has(thread.id) && (ancestor ? thread.parentThreadId === ancestor && archived.has(thread.id) === includeArchived : includeArchived ? archived.has(thread.id) : !archived.has(thread.id) && !descendantIds.includes(thread.id)));
      if (ancestor === 'a' && descendantCount) {
        const cursor = url.searchParams.get('cursor'); control.descendantReads.push({ archived: url.searchParams.get('archived'), cursor });
        if (cursor && descendantFailure) return json({ error: 'Fixture descendant page failed' }, 503);
        const start = Number(cursor || 0), limit = Number(url.searchParams.get('limit') || 100), next = start + limit;
        return json({ data: data.slice(start, next), nextCursor: descendantCursor === 'cycle' ? '100' : descendantCursor === 'malformed' ? 7 : next < data.length ? String(next) : null });
      }
      return json({ data, nextCursor: null });
    }
    if (pathname.startsWith('/api/threads/')) {
      const thread = threads.find(item => item.id === pathname.split('/')[3]);
      if (!thread || deleted.has(thread.id)) return json({ error: 'Conversation deleted' }, 404);
      return json({ thread, data: [{ turnId: `turn-${thread.id}`, turnStatus: 'completed', item: { id: `reply-${thread.id}`, type: 'agentMessage', text: `Reply ${thread.id.toUpperCase()}` } }, { turnId: `turn-${thread.id}`, turnStatus: 'completed', item: { id: `user-${thread.id}`, type: 'userMessage', content: [{ type: 'text', text: `Original ${thread.id.toUpperCase()}` }] } }], nextCursor: null });
    }
    if (pathname.startsWith('/api/')) { errors.push(`Unexpected GET ${pathname}`); return json({ error: 'Unknown fixture endpoint' }, 404); }
    const file = path.join(output, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream'); res.end(fs.readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  t.after(async () => { if (!requests.length || process.env.ELPIS_AVAILABILITY_DEBUG) t.diagnostic(JSON.stringify({ body: await page.locator('body').innerText(), archived: [...archived], requests })); for (const finish of held) { try { finish({ error: 'Fixture ended' }, 503); } catch {} } await browser?.close(); for (const client of [...clients, ...loveClients]) client.end(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(errors, [], 'Fixture must have no endpoint or renderer failures'); });
  browser = await chromium.launch({ headless: true, executablePath: process.env.ELPIS_CHROMIUM || undefined });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const network = await page.context().newCDPSession(page); await network.send('Network.enable'); await network.send('Network.setCacheDisabled', { cacheDisabled: true });
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') t.diagnostic(message.text()); }); page.setDefaultTimeout(4000);
  await guardDesktopStore(page);
  await page.addInitScript(descendantIds => {
    const saved = new Map([['elpis-draft-v1:recovery-a', 'Recovered edit A'], ['elpis-draft-v1:c', 'Unsent child C'], ['elpis-draft-v1:recovery-c', 'Recovered child C'], ['elpis-draft-v1:b', 'Unsent B'], ['elpis-draft-v1:recovery-b', 'Recovered edit B']]);
    if (descendantIds.length) saved.set('elpis-draft-v1:a', 'Unsent A');
    for (const id of descendantIds) { saved.set(`elpis-draft-v1:${id}`, `Unsent ${id}`); saved.set(`elpis-draft-v1:recovery-${id}`, `Recovered ${id}`); }
    window.elpisDesktop = { storage: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key), onError: () => () => {} } };
  }, descendantIds);
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  const ready = () => eventually(async () => assert.equal(await composer.isEnabled(), true, 'A healthy runtime must become ready independently of its model catalogue'));
  const open = async id => { await leaveSettings(page); await page.locator('.thread-link').filter({ hasText: `Availability chat ${id.toUpperCase()}` }).click(); await eventually(async () => assert.equal(await page.getByRole('button', { name: 'Refresh conversation', exact: true }).isEnabled(), true)); await eventually(async () => assert.equal(await page.locator('.user-turn, form[aria-label="Edit message"]').count(), 1)); };
  const archivedPage = async () => { await leaveSettings(page); await openSettings(page); await page.getByRole('tab', { name: 'Archived chats', exact: true }).click(); };
  const restore = async (id, reopen = true) => { await archivedPage(); await page.getByRole('button', { name: `Unarchive Availability chat ${id.toUpperCase()}`, exact: true }).click(); if (reopen) await open(id); };
  const permanent = async id => {
    // Keep the descendants' archive states mixed so both preflight scans are exercised.
    archived.add(id); emit('message', { method: 'thread/archived', params: { threadId: id } });
    await archivedPage(); await page.getByRole('textbox', { name: 'Search archived chats', exact: true }).fill(`Availability chat ${id.toUpperCase()}`);
    await page.locator(`.archived-row[data-thread-id="${id}"]`).getByRole('button', { name: `Actions for Availability chat ${id.toUpperCase()}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('alertdialog'); await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await eventually(async () => assert.ok(!await dialog.isVisible() || await dialog.getByRole('alert').count(), 'Deletion must finish or explain its preflight failure'));
  };
  const saved = key => page.evaluate(key => window.elpisDesktop.storage.getItem(`elpis-draft-v1:${key}`), key);
  return { page, composer, ready, open, restore, permanent, saved, external, emit, clients, requests, posts, control, held, descendantIds };
}

test('archive HTTP success preserves composer, message edit and recovery; permanent deletion disposes only its subtree', async t => {
  const f = await fixture(t); await f.ready(); await f.open('b');
  await f.page.getByRole('button', { name: 'Edit message', exact: true }).click(); await f.page.getByRole('textbox', { name: 'Edited message', exact: true }).fill('Edited B');
  await f.open('a'); await f.composer.fill('Unsent A'); await f.page.getByRole('button', { name: 'Edit message', exact: true }).click(); await f.page.getByRole('textbox', { name: 'Edited message', exact: true }).fill('Edited A');
  await f.page.getByRole('button', { name: 'Actions for Availability chat A', exact: true }).click(); await f.page.getByRole('menuitem', { name: 'Archive', exact: true }).click();
  await eventually(async () => assert.equal(await f.page.locator('.thread-link').filter({ hasText: 'Availability chat A' }).count(), 0));
  await f.restore('a');
  assert.equal(await f.composer.inputValue(), 'Unsent A', 'Archive/unarchive must retain the unsent composer draft');
  assert.equal(await f.page.getByRole('textbox', { name: 'Edited message', exact: true }).inputValue(), 'Edited A'); assert.equal(await f.saved('recovery-a'), 'Recovered edit A');
  assert.equal(await f.saved('c'), 'Unsent child C'); assert.equal(await f.saved('recovery-c'), 'Recovered child C'); await f.restore('c', false); await f.open('a');
  await f.permanent('a');
  await eventually(async () => assert.equal(await f.saved('a'), null)); assert.equal(await f.saved('recovery-a'), null); assert.equal(await f.saved('c'), null); assert.equal(await f.saved('recovery-c'), null);
  await f.open('b'); assert.equal(await f.composer.inputValue(), 'Unsent B'); assert.equal(await f.page.getByRole('textbox', { name: 'Edited message', exact: true }).inputValue(), 'Edited B'); assert.equal(await f.saved('recovery-b'), 'Recovered edit B');
  assert.equal(f.posts.filter(post => post.path.endsWith('/turns') || post.path.endsWith('/revert')).length, 0);
});

test('native archive events retain drafts; native deletion clears only that conversation', async t => {
  const f = await fixture(t); await f.ready(); await eventually(() => assert.equal(f.clients.size, 1)); await f.open('a'); await f.composer.fill('SSE draft A');
  f.external('thread/archived', 'a'); await f.restore('a'); assert.equal(await f.composer.inputValue(), 'SSE draft A', 'A native archive event must preserve the composer draft'); assert.equal(await f.saved('recovery-a'), 'Recovered edit A'); assert.equal(await f.saved('c'), 'Unsent child C'); assert.equal(await f.saved('recovery-c'), 'Recovered child C');
  f.external('thread/deleted', 'a'); await eventually(async () => assert.equal(await f.saved('a'), null)); assert.equal(await f.saved('recovery-a'), null); assert.equal(await f.saved('c'), null); assert.equal(await f.saved('recovery-c'), null); assert.equal(await f.saved('b'), 'Unsent B'); assert.equal(await f.saved('recovery-b'), 'Recovered edit B');
  assert.equal(f.posts.filter(post => !post.path.endsWith('/resume') && !post.path.endsWith('/unarchive')).length, 0);
});

test('deletion disposes later-page active and archived descendant drafts and preserves an unrelated edit', async t => {
  const f = await fixture(t, { descendantCount: 125, archivedDescendantCount: 125 }); await f.ready(); await f.open('b');
  await f.composer.fill('Unrelated B remains'); await f.page.getByRole('button', { name: 'Edit message', exact: true }).click(); await f.page.getByRole('textbox', { name: 'Edited message', exact: true }).fill('Unrelated edited B');
  assert.equal(f.control.descendantReads.length, 0, 'The 125 descendants must not already be loaded'); assert.equal(await f.saved('unloaded-125'), 'Unsent unloaded-125');
  await f.permanent('a');
  await eventually(async () => assert.equal(await f.page.locator('.thread-link').filter({ hasText: 'Availability chat A' }).count(), 0));
  const remaining = await f.page.evaluate(ids => ids.flatMap(id => [window.elpisDesktop.storage.getItem(`elpis-draft-v1:${id}`), window.elpisDesktop.storage.getItem(`elpis-draft-v1:recovery-${id}`)]), f.descendantIds);
  assert.deepEqual(remaining, Array(f.descendantIds.length * 2).fill(null), 'Deleting a conversation must clear all descendant drafts, including later pages');
  assert.deepEqual(f.control.descendantReads, [{ archived: 'false', cursor: null }, { archived: 'false', cursor: '100' }, { archived: 'true', cursor: null }, { archived: 'true', cursor: '100' }]); assert.equal(f.posts.filter(post => post.path === '/api/threads/a/delete').length, 1);
  assert.equal(await f.saved('a'), null); assert.equal(await f.saved('recovery-a'), null); assert.equal(await f.saved('c'), null); assert.equal(await f.saved('recovery-c'), null);
  await leaveSettings(f.page); assert.equal(await f.composer.inputValue(), 'Unrelated B remains'); assert.equal(await f.page.getByRole('textbox', { name: 'Edited message', exact: true }).inputValue(), 'Unrelated edited B'); assert.equal(await f.saved('recovery-b'), 'Recovered edit B');
});

for (const [name, options, reads] of [['a later descendant page fails', { descendantFailure: true }, 2], ['the descendant cursor repeats', { descendantCursor: 'cycle' }, 2], ['the descendant cursor is malformed', { descendantCursor: 'malformed' }, 1]]) {
  test(`deletion refuses to mutate or lose drafts when ${name}`, async t => {
    const f = await fixture(t, { descendantCount: 125, ...options }); await f.ready(); await f.open('b'); await f.composer.fill('Unrelated B remains');
    assert.equal(f.control.descendantReads.length, 0);
    await f.permanent('a');
    await eventually(async () => assert.ok(f.posts.some(post => post.path === '/api/threads/a/delete') || /could not read|failed|invalid|incomplete/i.test(await f.page.getByRole('alertdialog').innerText())));
    assert.equal(f.posts.filter(post => post.path === '/api/threads/a/delete').length, 0, 'Incomplete descendant discovery must not send a deletion');
    assert.equal(f.control.descendantReads.length, reads); assert.equal(await f.saved('a'), 'Unsent A'); assert.equal(await f.saved('recovery-a'), 'Recovered edit A'); assert.equal(await f.saved('c'), 'Unsent child C'); assert.equal(await f.saved('recovery-c'), 'Recovered child C');
    const retained = await f.page.evaluate(ids => ids.flatMap(id => [window.elpisDesktop.storage.getItem(`elpis-draft-v1:${id}`), window.elpisDesktop.storage.getItem(`elpis-draft-v1:recovery-${id}`)]), f.descendantIds);
    assert.deepEqual(retained, f.descendantIds.flatMap(id => [`Unsent ${id}`, `Recovered ${id}`]), 'Every descendant draft must survive an incomplete preflight');
    await f.page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click(); await leaveSettings(f.page); assert.equal(await f.composer.inputValue(), 'Unrelated B remains'); assert.equal(await f.saved('recovery-b'), 'Recovered edit B');
    await f.restore('a', false); await eventually(async () => assert.equal(await f.page.locator('.thread-link').filter({ hasText: 'Availability chat A' }).count(), 1, 'A failed permanent deletion must leave the archived chat restorable'));
  });
}

test('catalogue sign-in failure leaves healthy history and live feed usable; retry recovers without sending or switching', async t => {
  const f = await fixture(t, { modelFailure: true }); await f.ready(); await eventually(() => assert.equal(f.clients.size, 1)); await f.open('a');
  const model = f.page.getByRole('combobox', { name: 'Model', exact: true }); const previous = await model.getAttribute('data-value');
  await eventually(async () => assert.ok((await f.page.getByRole('alert').allTextContents()).join('\n').includes('Fixture sign-in required for models')));
  f.emit('message', { method: 'item/completed', params: { threadId: 'a', turnId: 'live-a', item: { id: 'live-reply-a', type: 'agentMessage', text: 'Live feed still works' } } }); await eventually(async () => assert.ok((await f.page.locator('.chat-view').innerText()).includes('Live feed still works')));
  if (process.env.ELPIS_AVAILABILITY_SHOTS) {
    const inspectControls = () => f.page.evaluate(() => {
      const context = document.querySelector('.workspace-header button[aria-label="Refresh conversation"]');
      const inspect = button => {
        const style = getComputedStyle(button), ancestors = []; let parent = button.parentElement;
        for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) { const css = getComputedStyle(parent); ancestors.push({ tag: parent.tagName, class: parent.className, color: css.color, background: css.backgroundColor }); }
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const paint = canvas.getContext('2d'); paint.fillStyle = '#fff'; paint.fillRect(0, 0, 1, 1);
        for (const background of [...ancestors].reverse().map(ancestor => ancestor.background).concat(style.backgroundColor)) { paint.fillStyle = background; paint.fillRect(0, 0, 1, 1); }
        const effectiveBackground = `rgb(${[...paint.getImageData(0, 0, 1, 1).data].slice(0, 3).join(', ')})`;
        return { name: button.getAttribute('aria-label') || button.textContent.trim(), class: button.className, style: button.getAttribute('style'), disabled: button.disabled, color: style.color, background: style.backgroundColor, effectiveBackground, opacity: style.opacity, colorScheme: style.colorScheme, foreground: style.getPropertyValue('--foreground'), colorForeground: style.getPropertyValue('--color-foreground'), backgroundVariable: style.getPropertyValue('--background'), transitionProperty: style.transitionProperty, transitionDuration: style.transitionDuration, animations: button.getAnimations().map(animation => ({ type: animation.constructor.name, property: animation.transitionProperty, currentTime: animation.currentTime, duration: animation.effect.getComputedTiming().duration })), ancestors };
      };
      const matching = [];
      const visit = (rules, groups = []) => { for (const rule of rules) {
        if (rule.media && !matchMedia(rule.conditionText).matches) continue;
        if (rule.constructor.name === 'CSSSupportsRule' && !CSS.supports(rule.conditionText)) continue;
        if (rule.selectorText && (rule.style.color || rule.style.all || rule.style.webkitTextFillColor)) { try { if (context.matches(rule.selectorText)) matching.push({ selector: rule.selectorText, color: rule.style.color, all: rule.style.all, textFillColor: rule.style.webkitTextFillColor, groups }); } catch {} }
        if (rule.cssRules) visit(rule.cssRules, [...groups, rule.name || rule.conditionText || rule.constructor.name]);
      } };
      for (const sheet of document.styleSheets) visit(sheet.cssRules);
      const retry = [...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Retry models');
      return { htmlClass: document.documentElement.className, bodyClass: document.body.className, buttons: [context, document.querySelector('.workspace-header .mobile-menu'), retry].map(inspect), contextMatchingRules: matching };
    });
    const light = await inspectControls(); t.diagnostic(`Light control trace ${JSON.stringify(light)}`);
    const folder = process.env.ELPIS_AVAILABILITY_SHOTS; fs.mkdirSync(folder, { recursive: true }); await f.page.screenshot({ path: path.join(folder, 'catalogue-error-desktop-light.png') });
    await f.page.emulateMedia({ colorScheme: 'dark' }); await f.page.setViewportSize({ width: 390, height: 844 }); await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const changing = await inspectControls(); t.diagnostic(`Changing mobile dark control trace ${JSON.stringify(changing)}`);
    await f.page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().endTime !== Infinity).map(animation => animation.finished.catch(() => {}))));
    const dark = await inspectControls(); t.diagnostic(`Settled mobile dark control trace ${JSON.stringify(dark)}`);
    await f.page.screenshot({ path: path.join(folder, 'catalogue-error-mobile-dark.png') });
    const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    for (const [theme, trace] of [['light', light], ['dark', dark]]) for (const button of trace.buttons) {
      const a = luminance(button.color), b = luminance(button.effectiveBackground), contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
      assert.equal(button.disabled, false); assert.equal(button.opacity, '1'); assert.ok(contrast >= 4.5, `${theme} enabled ${button.name} must remain readable (contrast ${contrast.toFixed(2)})`);
    }
  }
  f.control.modelFailure = false; await f.page.getByRole('button', { name: 'Retry models', exact: true }).click();
  await eventually(async () => assert.equal((await f.page.getByRole('alert').allTextContents()).join('\n').includes('Fixture sign-in required for models'), false)); assert.equal(await model.getAttribute('data-value'), previous); assert.equal(f.clients.size, 1); assert.equal(f.posts.filter(post => !post.path.endsWith('/resume')).length, 0);
});

test('slow catalogues never gate startup; old success cannot overwrite newer models/errors or an explicit choice', async t => {
  const f = await fixture(t, { holdModels: true }); await f.ready(); await eventually(() => assert.equal(f.clients.size, 1)); await f.open('a'); await eventually(() => assert.equal(f.held.length, 1));
  f.emit('account', { method: 'account/updated' }); await eventually(() => assert.equal(f.held.length, 2)); f.held[1]({ data: [sol, latest], nextCursor: null });
  await f.page.getByRole('button', { name: 'New chat', exact: true }).click();
  const model = f.page.getByRole('combobox', { name: 'Model', exact: true }); await model.click(); await f.page.getByRole('tab', { name: 'Alternate local', exact: true }).click(); await f.page.getByRole('option').filter({ hasText: 'Local choice' }).click(); assert.equal(await model.getAttribute('data-value'), 'local-choice'); const provider = await model.locator('.model-trigger-provider').innerText(); assert.equal(provider, 'Alternate local');
  f.emit('account', { method: 'account/updated' }); await eventually(() => assert.equal(f.held.length, 3)); f.held[2]({ error: 'Newer catalogue failure' }, 503); await eventually(async () => assert.ok((await f.page.getByRole('alert').allTextContents()).join('\n').includes('Newer catalogue failure')));
  const oldResponse = f.page.waitForResponse(response => response.headers()['x-fixture-model-read'] === '1'); f.held[0]({ data: [{ id: 'old-model', model: 'old-model', displayName: 'Old model' }], nextCursor: null }); await (await oldResponse).finished(); await f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok((await f.page.getByRole('alert').allTextContents()).join('\n').includes('Newer catalogue failure')); assert.equal(await model.getAttribute('data-value'), 'local-choice'); assert.equal(await model.locator('.model-trigger-provider').innerText(), provider);
  await model.click(); await f.page.getByRole('tab', { name: 'All', exact: true }).click(); await eventually(async () => assert.equal(await f.page.getByRole('option').filter({ hasText: 'Latest model' }).count(), 1)); await f.page.keyboard.press('Escape');
  await f.page.getByRole('button', { name: 'Retry models', exact: true }).click(); await eventually(() => assert.equal(f.held.length, 4)); f.held[3]({ data: [sol, latest], nextCursor: null }); await eventually(async () => assert.equal((await f.page.getByRole('alert').allTextContents()).join('\n').includes('Newer catalogue failure'), false)); assert.equal(await model.getAttribute('data-value'), 'local-choice'); assert.equal(await model.locator('.model-trigger-provider').innerText(), provider); assert.equal(f.posts.filter(post => !post.path.endsWith('/resume')).length, 0);
});
