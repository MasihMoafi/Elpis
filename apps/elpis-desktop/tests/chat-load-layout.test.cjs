// A delayed agent list must not move a chat that is already visible.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');

const root = (id, name) => ({ id, name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } });
const child = (id, parentThreadId) => ({ ...root(id, `Helper ${id}`), parentThreadId, source: { subAgent: { thread_spawn: { agent_path: `/root/${id}`, parent_thread_id: parentThreadId, depth: 1 } } } });
const roots = [root('chat-a', 'First team'), root('chat-b', 'Second team'), root('chat-c', 'No team')];
const children = [child('agent-a', 'chat-a'), child('agent-b', 'chat-b')];
const storage = { 'elpis-last-chat': 'chat-a', 'elpis-sidebar-width': '376', 'elpis-preferences-v1': JSON.stringify({ transcriptWidth: 'l' }) };
function gate() {
  let release, started, startedAt;
  const waiting = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  return {
    release, requested,
    wait: async () => { startedAt ??= Date.now(); started(); await waiting; },
    holdFor: async ms => new Promise(resolve => setTimeout(resolve, Math.max(0, startedAt + ms - Date.now()))),
  };
}
async function requested(g) {
  let timer;
  try { await Promise.race([g.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected request did not start')), 6000); })]); }
  finally { clearTimeout(timer); }
}
function routes(gates = {}) {
  return {
    '/api/threads': async (_, url) => {
      const ancestor = url.searchParams.get('ancestorThreadId');
      if (!ancestor) return { data: url.searchParams.get('archived') === 'true' ? [] : roots, nextCursor: null };
      await gates[ancestor]?.wait();
      return { data: children.filter(item => item.parentThreadId === ancestor), nextCursor: null };
    },
    ...Object.fromEntries(children.map(item => [`/api/threads/${item.id}`, () => ({ thread: item, data: [], nextCursor: null })])),
  };
}
async function observe(page, requireMessage = false, allowNoComposer = false) {
  await page.evaluate(({ requireMessage, allowNoComposer }) => {
    window.__chatBounds = [];
    window.__chatObserving = true;
    function visible(element) {
      if (!element) return false;
      for (let current = element; current; current = current.parentElement) {
        const css = getComputedStyle(current);
        if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0) return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }
    function sample() {
      if (!window.__chatObserving) return;
      const composer = document.querySelector('.chat-view .composer');
      const content = document.querySelector('.chat-view .chat-content');
      if ((visible(composer) || allowNoComposer && !composer) && visible(content) && (!requireMessage || visible(content.querySelector('.message'))) && !document.querySelector('.startup-splash')) {
        const c = composer?.getBoundingClientRect(), t = content.getBoundingClientRect();
        const panel = document.querySelector('.team-panel');
        window.__chatBounds.push({ id: document.querySelector('.thread-row.active')?.getAttribute('data-thread-id'), panel: visible(panel), composerLeft: c?.left, composerWidth: c?.width, composerTop: c?.top, composerHeight: c?.height, chatLeft: t.left, chatWidth: t.width });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, { requireMessage, allowNoComposer });
}
async function samples(page) { return page.evaluate(() => { window.__chatObserving = false; return window.__chatBounds; }); }
function stable(samples, id) {
  const shown = samples.filter(sample => sample.id === id);
  assert.ok(shown.length >= 3, `recorded visible chat frames for ${id}; got ${JSON.stringify(shown)}`);
  const first = shown[0];
  for (const sample of shown) {
    for (const key of ['composerLeft', 'composerWidth', 'composerTop', 'composerHeight', 'chatLeft', 'chatWidth']) {
      assert.ok(Math.abs(sample[key] - first[key]) < 1.5, `${id} ${key} moved from ${first[key]} to ${sample[key]}; frames ${JSON.stringify(shown.filter((v, i) => i === 0 || i === shown.length - 1))}`);
    }
  }
  return first;
}
async function shot(page, name) {
  if (!process.env.ELPIS_CHAT_LOAD_SHOTS) return;
  await fs.mkdir(process.env.ELPIS_CHAT_LOAD_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.ELPIS_CHAT_LOAD_SHOTS, name) });
}

test('the first visible chat and a switched chat keep their width while delayed teams load', async () => {
  const a = gate(), b = gate();
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1450, height: 820, threads: roots, routes: routes({ 'chat-a': a, 'chat-b': b }), storage });
  const { page } = f;
  try {
    await requested(a);
    await observe(page);
    await a.holdFor(2500);
    await page.locator('.chat-team-loading').waitFor({ state: 'visible' });
    await shot(page, 'before-first-team.png');
    a.release();
    await page.locator('.team-panel').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Working agents only', exact: true }).click();
    await page.locator('.chat-content .message').first().waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    await shot(page, 'first-team-ready.png');
    assert.equal(stable(await samples(page), 'chat-a').panel, true, 'the first visible chat already has its team panel');

    await observe(page);
    await page.locator('.thread-row[data-thread-id="chat-b"] .thread-link').click();
    await requested(b);
    await b.holdFor(2500);
    b.release();
    await page.locator('.team-row[data-thread-id="agent-b"]').waitFor({ state: 'visible' });
    await page.waitForTimeout(300);
    assert.equal(stable(await samples(page), 'chat-b').panel, true, 'the switched chat already has its team panel');

    await observe(page, false, true);
    await page.locator('.team-row[data-thread-id="agent-b"]').click();
    await page.locator('.team-row[data-thread-id="agent-b"].active').waitFor();
    await page.waitForTimeout(300);
    const sameTeam = await samples(page);
    assert.ok(sameTeam.length >= 3, 'agent navigation shows the chat');
    const first = sameTeam[0];
    assert.ok(sameTeam.every(frame => frame.panel && Math.abs(frame.chatLeft - first.chatLeft) < 1.5 && Math.abs(frame.chatWidth - first.chatWidth) < 1.5), 'the team panel and transcript bounds stay in place when opening an agent');
    assert.deepEqual(f.errors, []);
  } finally { a.release(); b.release(); await f.close(); }
});

test('explicit panel toggle resizes, empty teams do not reserve space, and stale team replies do not affect another chat', async () => {
  const b = gate();
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1450, height: 820, colorScheme: 'dark', threads: roots, routes: routes({ 'chat-b': b }), storage });
  const { page, composer } = f;
  try {
    await page.locator('.team-panel').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Working agents only', exact: true }).click();
    await page.locator('.team-row[data-thread-id="agent-a"]').waitFor({ state: 'visible' });
    const width = () => page.locator('.composer').evaluate(el => el.getBoundingClientRect().width);
    const withPanel = await width();
    await page.getByRole('button', { name: 'Hide agents panel' }).click();
    await page.locator('.team-panel').waitFor({ state: 'detached' });
    const withoutPanel = await width();
    assert.ok(withoutPanel > withPanel + 100, `hiding the panel deliberately expands the chat: ${withPanel} to ${withoutPanel}`);
    await page.getByRole('button', { name: 'Show agents panel' }).click();
    await page.locator('.team-panel').waitFor({ state: 'visible' });

    await composer.fill('A draft stays here');
    await page.locator('input[aria-label="Choose files"]').setInputFiles({ name: 'draft.png', mimeType: 'image/png', buffer: PNG });
    await page.getByText('draft.png').waitFor();
    await composer.focus();
    const position = await page.locator('.thread-row[data-depth="0"]').evaluateAll(rows => rows.findIndex(row => row.getAttribute('data-thread-id') === 'chat-b') + 1);
    assert.ok(position > 0 && position <= 9, 'the second root has a chat shortcut');
    await page.keyboard.press(`Alt+${position}`);
    await requested(b);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Message Elpis', 'keyboard navigation keeps composer focus during loading');
    await page.keyboard.type('B draft while loading');
    await page.locator('.thread-row[data-thread-id="chat-c"] .thread-link').click();
    await page.waitForFunction(() => document.querySelector('.thread-row.active')?.getAttribute('data-thread-id') === 'chat-c');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.team-panel').count(), 0, 'a chat with no agents has no empty panel');
    const noTeamWidth = await width();
    assert.ok(noTeamWidth > withPanel + 100, `the no-team chat uses the open space: ${withPanel} to ${noTeamWidth}`);
    b.release();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.team-panel').count(), 0, 'a late reply for a different chat does not open a panel');
    assert.ok(Math.abs(await width() - noTeamWidth) < 1.5, 'a late reply for a different chat does not resize the current chat');

    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await page.waitForFunction(() => document.querySelector('.thread-row.active')?.getAttribute('data-thread-id') === 'chat-a');
    assert.equal(await composer.inputValue(), 'A draft stays here');
    assert.equal(await composer.evaluate(el => getComputedStyle(el.closest('.composer-wrap')).opacity), '1', 'a cached team opens immediately');
    assert.equal(await page.getByText('draft.png').count(), 1, 'the attachment stays with its draft');
    await page.locator('.thread-row[data-thread-id="chat-b"] .thread-link').click();
    await page.waitForFunction(() => document.querySelector('.thread-row.active')?.getAttribute('data-thread-id') === 'chat-b');
    assert.equal(await composer.inputValue(), 'B draft while loading', 'typing during the team read is kept with its chat');
    await shot(page, 'returned-draft-dark.png');
    assert.deepEqual(f.errors, []);
  } finally { b.release(); await f.close(); }
});

test('the existing panel toggle releases a draft while the team read is stalled', async () => {
  const a = gate();
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1450, height: 820, threads: roots, routes: routes({ 'chat-a': a }), storage });
  try {
    await requested(a);
    await f.page.getByRole('button', { name: 'Hide agents panel' }).click();
    await f.page.waitForFunction(() => getComputedStyle(document.querySelector('.composer-wrap')).opacity === '1');
    await f.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message Elpis');
    await f.composer.fill('Draft while the team read is stalled');
    const before = await f.composer.boundingBox();
    a.release();
    await f.page.getByRole('button', { name: 'Show agents panel' }).waitFor();
    assert.equal(await f.page.locator('.team-panel').count(), 0, 'the late response does not open the panel');
    const after = await f.composer.boundingBox();
    assert.ok(Math.abs(before.width - after.width) < 1.5 && Math.abs(before.x - after.x) < 1.5);
    assert.equal(await f.composer.inputValue(), 'Draft while the team read is stalled');
    await f.page.getByRole('button', { name: 'Show agents panel' }).click();
    await f.page.locator('.team-panel').waitFor({ state: 'visible' });
    assert.deepEqual(f.errors, []);
  } finally { a.release(); await f.close(); }
});

test('a refused team read leaves the draft usable and requires a deliberate panel open', async () => {
  const fallback = routes();
  let attempts = 0;
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1450, height: 820, threads: roots, storage, routes: {
    ...fallback,
    '/api/threads': (_, url) => url.searchParams.get('ancestorThreadId') === 'chat-a' && attempts++ === 0
      ? { __http: 503, error: 'Agent list unavailable' }
      : fallback['/api/threads'](_, url),
  } });
  try {
    await f.page.getByText(/Agent list unavailable/).waitFor();
    await f.composer.fill('A draft after the agent list failed');
    assert.equal(await f.composer.inputValue(), 'A draft after the agent list failed');
    assert.equal(await f.page.locator('.team-panel').count(), 0);
    await f.page.locator('.thread-row[data-thread-id="chat-c"] .thread-link').click();
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await f.page.getByRole('button', { name: 'Show agents panel' }).waitFor();
    assert.equal(await f.page.locator('.team-panel').count(), 0, 'a later successful read does not open the panel after fallback');
    assert.equal(await f.composer.inputValue(), 'A draft after the agent list failed');
    await f.page.getByRole('button', { name: 'Show agents panel' }).click();
    await f.page.locator('.team-panel').waitFor({ state: 'visible' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('an offline draft stays usable and a late team needs a deliberate open', async () => {
  const a = gate();
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1450, height: 820, threads: roots, routes: routes({ 'chat-a': a }), storage });
  try {
    await requested(a);
    await f.emit('connection', { connected: false });
    await f.page.getByText(/Elpis is disconnected/).first().waitFor();
    await f.page.waitForFunction(() => getComputedStyle(document.querySelector('.composer-wrap')).opacity === '1');
    await f.composer.fill('Editable while disconnected');
    const before = await f.composer.boundingBox();
    await observe(f.page);
    await f.emit('connection', { connected: true });
    a.release();
    await f.page.getByRole('button', { name: 'Show agents panel' }).waitFor();
    await f.page.waitForTimeout(300);
    assert.equal(await f.page.locator('.team-panel').count(), 0, 'reconnection does not open the panel over an already visible draft');
    const after = await f.composer.boundingBox();
    assert.ok(Math.abs(before.width - after.width) < 1.5 && Math.abs(before.x - after.x) < 1.5);
    stable(await samples(f.page), 'chat-a');
    assert.equal(await f.composer.inputValue(), 'Editable while disconnected');
    await f.page.getByRole('button', { name: 'Show agents panel' }).click();
    await f.page.locator('.team-panel').waitFor({ state: 'visible' });
    assert.equal(await f.composer.inputValue(), 'Editable while disconnected');
    assert.deepEqual(f.errors, []);
  } finally { a.release(); await f.close(); }
});

test('narrow chats stay editable while the hidden team panel loads', async () => {
  const a = gate();
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 820, height: 800, threads: roots, routes: routes({ 'chat-a': a }), storage });
  try {
    await requested(a);
    assert.equal(await f.composer.isVisible(), true);
    assert.equal(await f.composer.evaluate(el => getComputedStyle(el.closest('.composer-wrap')).opacity), '1', 'the composer stays visible on the narrow layout');
    const before = await f.composer.boundingBox();
    await f.composer.fill('Draft on a narrow screen');
    await shot(f.page, 'narrow-team-loading.png');
    a.release();
    await f.page.locator('.team-panel small').filter({ hasText: '0 working · 1 total' }).waitFor({ state: 'attached' });
    assert.equal(await f.page.locator('.team-panel').isVisible(), false);
    assert.equal(await f.composer.inputValue(), 'Draft on a narrow screen');
    const after = await f.composer.boundingBox();
    assert.ok(Math.abs(before.width - after.width) < 1.5 && Math.abs(before.x - after.x) < 1.5);
    assert.deepEqual(f.errors, []);
  } finally { a.release(); await f.close(); }
});

test('a restored draft remains visible during sign-in and a late team needs a deliberate open', async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1450, height: 820, threads: roots, routes: routes(), storage });
  const auth = gate();
  try {
    await f.page.locator('.team-panel').waitFor({ state: 'visible' });
    await f.page.route('**/api/session', async route => { await auth.wait(); await route.continue(); });
    const url = new URL('/?session=chat-a#token=fixture', f.page.url()).href;
    await f.page.goto(url, { waitUntil: 'domcontentloaded' });
    await requested(auth);
    await f.page.locator('.startup-splash').waitFor({ state: 'visible' });
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await f.composer.evaluate(el => getComputedStyle(el.closest('.composer-wrap')).opacity), '1');
    await f.composer.fill('Draft during sign-in');
    const before = await f.composer.boundingBox();
    auth.release();
    await f.page.getByRole('button', { name: 'Show agents panel' }).waitFor();
    assert.equal(await f.page.locator('.team-panel').count(), 0);
    const after = await f.composer.boundingBox();
    assert.ok(Math.abs(before.width - after.width) < 1.5 && Math.abs(before.x - after.x) < 1.5);
    assert.equal(await f.composer.inputValue(), 'Draft during sign-in');
    await f.page.getByRole('button', { name: 'Show agents panel' }).click();
    await f.page.locator('.team-panel').waitFor({ state: 'visible' });
    assert.deepEqual(f.errors, []);
  } finally { auth.release(); await f.close(); }
});
