// A delayed agent list must not move a chat that is already visible.
import type { Locator, Page } from 'playwright-core';
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const path: typeof import('node:path') = require('node:path');
type Thread = { id: string; name: string; cwd: string; model: string; modelProvider: string; status: { type: string }; desktopAccess: { writable: boolean; mode: string; reason: null } };
type Route = (body: unknown, url: URL) => unknown;
type ParityFixture = { page: Page; composer: Locator; errors: string[]; emit(event: string, data: unknown): void; close(): Promise<void> };
const { fixture, CWD }: { fixture(options: { staticDir?: string | undefined; width?: number; height?: number; colorScheme?: 'light' | 'dark'; threads?: Thread[]; routes?: Record<string, Route>; storage?: Record<string, string> }): Promise<ParityFixture>; CWD: string } = require('./parity-fixture.cts');
type ChatBounds = { id: string | null | undefined; panel: boolean; composerLeft: number | undefined; composerWidth: number | undefined; composerTop: number | undefined; composerHeight: number | undefined; chatLeft: number; chatWidth: number };
type ChatWindow = typeof window & { __chatBounds: ChatBounds[]; __chatObserving: boolean };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');

const root = (id: string, name: string) => ({ id, name, cwd: CWD, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } });
const child = (id: string, parentThreadId: string) => ({ ...root(id, `Helper ${id}`), parentThreadId, source: { subAgent: { thread_spawn: { agent_path: `/root/${id}`, parent_thread_id: parentThreadId, depth: 1 } } } });
const roots = [root('chat-a', 'First team'), root('chat-b', 'Second team'), root('chat-c', 'No team')];
const children = [child('agent-a', 'chat-a'), child('agent-b', 'chat-b')];
const storage = { 'elpis-last-chat': 'chat-a', 'elpis-sidebar-width': '376', 'elpis-preferences-v1': JSON.stringify({ transcriptWidth: 'l' }) };
function gate() {
  let release = () => {}, started = () => {}, startedAt: number | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  return {
    release, requested,
    wait: async () => { startedAt ??= Date.now(); started(); await waiting; },
    holdFor: async (ms: number) => new Promise<void>(resolve => setTimeout(resolve, Math.max(0, (startedAt ?? NaN) + ms - Date.now()))),
  };
}
async function requested(g: ReturnType<typeof gate>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([g.requested, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Expected request did not start')), 6000); })]); }
  finally { clearTimeout(timer); }
}
function routes(gates: Record<string, ReturnType<typeof gate>> = {}) {
  return {
    '/api/threads': async (_: unknown, url: URL) => {
      const ancestor = url.searchParams.get('ancestorThreadId');
      if (!ancestor) return { data: url.searchParams.get('archived') === 'true' ? [] : roots, nextCursor: null };
      await gates[ancestor]?.wait();
      return { data: children.filter(item => item.parentThreadId === ancestor), nextCursor: null };
    },
    ...Object.fromEntries(children.map(item => [`/api/threads/${item.id}`, () => ({ thread: item, data: [], nextCursor: null })])),
  };
}
async function observe(page: Page, requireMessage = false, allowNoComposer = false) {
  await page.evaluate(({ requireMessage, allowNoComposer }) => {
    const target = window as ChatWindow; target.__chatBounds = [];
    target.__chatObserving = true;
    function visible(element: Element | null) {
      if (!element) return false;
      for (let current: Element | null = element; current; current = current.parentElement) {
        const css = getComputedStyle(current);
        if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0) return false;
      }
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    }
    function sample() {
      if (!target.__chatObserving) return;
      const composer = document.querySelector('.chat-view .composer');
      const content = document.querySelector('.chat-view .chat-content');
      if ((visible(composer) || allowNoComposer && !composer) && content && visible(content) && (!requireMessage || visible(content.querySelector('.message'))) && !document.querySelector('.startup-splash')) {
        const c = composer?.getBoundingClientRect(), t = content.getBoundingClientRect();
        const panel = document.querySelector('.team-panel');
        target.__chatBounds.push({ id: document.querySelector('.thread-row.active')?.getAttribute('data-thread-id'), panel: visible(panel), composerLeft: c?.left, composerWidth: c?.width, composerTop: c?.top, composerHeight: c?.height, chatLeft: t.left, chatWidth: t.width });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  }, { requireMessage, allowNoComposer });
}
async function samples(page: Page) { return page.evaluate(() => { const target = window as ChatWindow; target.__chatObserving = false; return target.__chatBounds; }); }
function stable(samples: ChatBounds[], id: string) {
  const shown = samples.filter(sample => sample.id === id);
  assert.ok(shown.length >= 3, `recorded visible chat frames for ${id}; got ${JSON.stringify(shown)}`);
  const first = shown[0]; assert.ok(first);
  for (const sample of shown) {
    for (const key of ['composerLeft', 'composerWidth', 'composerTop', 'composerHeight', 'chatLeft', 'chatWidth'] as const) {
      const actual = sample[key], initial = first[key]; assert.ok(typeof actual === 'number' && typeof initial === 'number');
      assert.ok(Math.abs(actual - initial) < 1.5, `${id} ${key} moved from ${first[key]} to ${sample[key]}; frames ${JSON.stringify(shown.filter((v, i) => i === 0 || i === shown.length - 1))}`);
    }
  }
  return first;
}
async function shot(page: Page, name: string) {
  if (!process.env.ELPIS_CHAT_LOAD_SHOTS) return;
  await fs.mkdir(process.env.ELPIS_CHAT_LOAD_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.ELPIS_CHAT_LOAD_SHOTS, name) });
}

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
    assert.equal(await composer.evaluate(el => { const wrap = el.closest('.composer-wrap'); if (!wrap) throw Error('Composer wrapper missing'); return getComputedStyle(wrap).opacity; }), '1', 'a cached team opens immediately');
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
    await f.page.waitForFunction(() => { const wrap = document.querySelector('.composer-wrap'); if (!wrap) throw Error('Composer wrapper missing'); return getComputedStyle(wrap).opacity === '1'; });
    await f.page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Message Elpis');
    await f.composer.fill('Draft while the team read is stalled');
    const before = await f.composer.boundingBox();
    a.release();
    await f.page.getByRole('button', { name: 'Show agents panel' }).waitFor();
    assert.equal(await f.page.locator('.team-panel').count(), 0, 'the late response does not open the panel');
    const after = await f.composer.boundingBox(); assert.ok(before && after);
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
    // 5 Nov, Masih: a background read's failure is "non-existent and meaningless"; it shows no error bar.
    const end = Date.now() + 6000; while (attempts === 0 && Date.now() < end) await f.page.waitForTimeout(100);
    assert.ok(attempts > 0, 'the agent list was read and refused');
    await f.page.waitForTimeout(500);
    assert.equal(await f.page.getByText(/Agent list unavailable/).count(), 0);
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
    f.emit('connection', { connected: false });
    await f.page.getByText(/Elpis is disconnected/).first().waitFor();
    await f.page.waitForFunction(() => { const wrap = document.querySelector('.composer-wrap'); if (!wrap) throw Error('Composer wrapper missing'); return getComputedStyle(wrap).opacity === '1'; });
    await f.composer.fill('Editable while disconnected');
    const before = await f.composer.boundingBox();
    f.emit('connection', { connected: true });
    // The offline notice occupies space under the chat. Wait for its removal before measuring the delayed team,
    // so the notice's intentional disappearance is not mistaken for a panel-induced layout shift.
    await f.page.getByText(/Elpis is disconnected/).first().waitFor({ state: 'hidden' });
    await observe(f.page);
    await f.page.waitForFunction(() => (window as ChatWindow).__chatBounds.length >= 3);
    a.release();
    await f.page.getByRole('button', { name: 'Show agents panel' }).waitFor();
    await f.page.waitForTimeout(300);
    assert.equal(await f.page.locator('.team-panel').count(), 0, 'reconnection does not open the panel over an already visible draft');
    const after = await f.composer.boundingBox(); assert.ok(before && after);
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
    assert.equal(await f.composer.evaluate(el => { const wrap = el.closest('.composer-wrap'); if (!wrap) throw Error('Composer wrapper missing'); return getComputedStyle(wrap).opacity; }), '1', 'the composer stays visible on the narrow layout');
    const before = await f.composer.boundingBox();
    await f.composer.fill('Draft on a narrow screen');
    await shot(f.page, 'narrow-team-loading.png');
    a.release();
    await f.page.locator('.team-panel small').filter({ hasText: '0 working · 1 total' }).waitFor({ state: 'attached' });
    assert.equal(await f.page.locator('.team-panel').isVisible(), false);
    assert.equal(await f.composer.inputValue(), 'Draft on a narrow screen');
    const after = await f.composer.boundingBox(); assert.ok(before && after);
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
    assert.equal(await f.composer.evaluate(el => { const wrap = el.closest('.composer-wrap'); if (!wrap) throw Error('Composer wrapper missing'); return getComputedStyle(wrap).opacity; }), '1');
    await f.composer.fill('Draft during sign-in');
    const before = await f.composer.boundingBox();
    auth.release();
    await f.page.getByRole('button', { name: 'Show agents panel' }).waitFor();
    assert.equal(await f.page.locator('.team-panel').count(), 0);
    const after = await f.composer.boundingBox(); assert.ok(before && after);
    assert.ok(Math.abs(before.width - after.width) < 1.5 && Math.abs(before.x - after.x) < 1.5);
    assert.equal(await f.composer.inputValue(), 'Draft during sign-in');
    await f.page.getByRole('button', { name: 'Show agents panel' }).click();
    await f.page.locator('.team-panel').waitFor({ state: 'visible' });
    assert.deepEqual(f.errors, []);
  } finally { auth.release(); await f.close(); }
});
