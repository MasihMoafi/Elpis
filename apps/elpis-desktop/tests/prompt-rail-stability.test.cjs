// A prompt rail must not move the transcript when it appears.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD, TURNS } = require('./parity-fixture.cjs');

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
async function observe(page) {
  await page.evaluate(() => {
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
      if (visible(composer) && visible(content) && visible(content.querySelector('.message')) && !document.querySelector('.startup-splash')) {
        const c = composer.getBoundingClientRect(), t = content.getBoundingClientRect();
        const panel = document.querySelector('.team-panel');
        window.__chatBounds.push({ id: document.querySelector('.thread-row.active')?.getAttribute('data-thread-id'), panel: visible(panel), composerLeft: c.left, composerWidth: c.width, composerTop: c.top, composerHeight: c.height, chatLeft: t.left, chatWidth: t.width });
      }
      requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
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

test('a late prompt index does not narrow the visible transcript', async () => {
  const index = gate();
  const delayed = routes();
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1450, height: 820, threads: roots, chat: TURNS.slice(0, 1), storage, routes: {
    ...delayed,
    '/api/threads/chat-a/prompts': async () => {
      await index.wait();
      return { threadId: 'chat-a', data: Array.from({ length: 4 }, (_, i) => ({ turnId: `indexed-${i}`, text: `Earlier prompt ${i}` })) };
    },
  } });
  try {
    await requested(index);
    await f.page.locator('.team-panel').waitFor({ state: 'visible' });
    await observe(f.page);
    await index.holdFor(2500);
    await shot(f.page, 'before-index.png');
    index.release();
    await f.page.getByRole('navigation', { name: 'User messages' }).waitFor({ state: 'visible' });
    await f.page.locator('.chat-content .message').first().waitFor({ state: 'visible' });
    await f.page.waitForTimeout(300);
    await shot(f.page, 'index-ready.png');
    assert.equal(stable(await samples(f.page), 'chat-a').panel, true);
    assert.deepEqual(f.errors, []);
  } finally { index.release(); await f.close(); }
});

test('a new visible prompt can reveal the rail without moving the transcript', async () => {
  const base = routes();
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1450, height: 820, threads: roots, chat: TURNS.slice(0, 1), storage, routes: {
    ...base,
    '/api/threads/chat-a/prompts': () => ({ threadId: 'chat-a', data: [
      { turnId: 'old-one', text: 'Earlier one' }, { turnId: 'old-two', text: 'Earlier two' }, { turnId: 't1', text: TURNS[0][1] },
    ] }),
  } });
  try {
    await f.page.locator('.team-panel').waitFor({ state: 'visible' });
    await f.page.locator('.chat-content .message').first().waitFor({ state: 'visible' });
    await f.page.waitForTimeout(300);
    assert.equal(await f.page.locator('.prompt-rail').count(), 0, 'three indexed prompts do not yet show the rail');
    await observe(f.page);
    await f.composer.fill('A new visible prompt');
    await f.composer.press('Enter');
    const rail = f.page.getByRole('navigation', { name: 'User messages' });
    await rail.waitFor({ state: 'visible' });
    const mark = rail.locator('[data-slot="prompt-mark"]').last();
    await mark.hover();
    await f.page.waitForFunction(() => document.querySelector('.prompt-tick[data-distance="0"] i')?.getBoundingClientRect().width >= 25.9);
    const bounds = await rail.evaluate(node => {
      const content = document.querySelector('.chat-content').getBoundingClientRect();
      const boxes = [node, ...node.querySelectorAll('.prompt-tick, .prompt-tick i')].map(item => item.getBoundingClientRect());
      return { right: Math.max(...boxes.map(box => box.right)), left: content.left };
    });
    assert.ok(bounds.right <= bounds.left - 3, `rail targets and hover marks remain clear of text: ${JSON.stringify(bounds)}`);
    await mark.click();
    await f.page.waitForTimeout(300);
    await shot(f.page, 'rail-after-new-prompt.png');
    stable(await samples(f.page), 'chat-a');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
