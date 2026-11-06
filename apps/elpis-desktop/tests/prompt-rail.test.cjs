const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const indexOf = chat => ({ data: chat.map(([turnId, text, reply]) => ({ turnId, text, reply })) });
const marksOf = page => page.getByRole('navigation', { name: 'User messages' }).locator('[data-slot="prompt-mark"]');

async function railGeometry(page) {
  return page.locator('.prompt-rail').evaluate(rail => {
    const column = document.querySelector('.chat-content').getBoundingClientRect();
    const pane = rail.closest('.chat-scroll-wrap').getBoundingClientRect(), railBox = rail.getBoundingClientRect();
    const boxes = [rail, ...rail.querySelectorAll('.prompt-tick, .prompt-tick i')].map(node => node.getBoundingClientRect());
    return {
      gap: column.left - Math.max(...boxes.map(box => box.right)),
      left: railBox.left - pane.left, width: railBox.width,
      highlighted: rail.querySelector('[data-distance="0"] i')?.getBoundingClientRect().width ?? 0,
    };
  });
}
function assertRailGap(geometry) {
  assert.ok(geometry.left >= -0.5 && Math.abs(geometry.width - 28) < 0.5, `rail keeps its 28px width inside its pane: ${JSON.stringify(geometry)}`);
  assert.ok(geometry.gap >= 3.5, `rail stays clear of message text: ${JSON.stringify(geometry)}`);
  assert.ok(Math.abs(geometry.left - 16) < 0.5, `rail sits 16px from the pane edge, as in ChatGPT: ${JSON.stringify(geometry)}`);
}

test('a hidden rail releases its gutter in narrow windows and panes', async () => {
  const f = await fixture({ width: 1130, height: 800 });
  try {
    await f.open('chat-a');
    for (const [width, padding] of [[760, 16], [896, 22]]) {
      await f.page.setViewportSize({ width, height: 800 });
      assert.equal(await f.page.locator('.prompt-rail').isVisible(), false);
      assert.equal(await f.page.locator('.chat-scroll').evaluate(node => parseFloat(getComputedStyle(node).paddingLeft)), padding);
    }
    await f.page.setViewportSize({ width: 1130, height: 800 });
    await f.page.locator('.prompt-rail').waitFor({ state: 'visible', timeout: 2000 });
    assertRailGap(await railGeometry(f.page));
    await f.page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    assert.equal(await f.page.locator('.prompt-rail').isVisible(), false);
    assert.equal(await f.page.locator('.chat-scroll').evaluate(node => parseFloat(getComputedStyle(node).paddingLeft)), 22);
    await f.page.getByRole('button', { name: 'Close side panel', exact: true }).click();
    await f.open('chat-b');
    assert.equal(await f.page.locator('.prompt-rail').count(), 0);
    assert.equal(await f.page.locator('.chat-scroll').evaluate(node => parseFloat(getComputedStyle(node).paddingLeft)), 32);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('bookmarks restore from the desktop store when the loopback origin changes', async () => {
  const f = await fixture();
  try {
    await f.page.evaluate(() => {
      const storage = window.elpisDesktop.storage, read = storage.getItem.bind(storage);
      storage.getItem = key => key === 'elpis:prompt-rail-bookmarks:chat-a' ? '["t2"]' : read(key);
      localStorage.removeItem('elpis:prompt-rail-bookmarks:chat-a');
    });
    await f.open('chat-a');
    assert.equal(await marksOf(f.page).nth(1).getAttribute('data-bookmarked'), 'true');
  } finally { await f.close(); }
});

// Masih, 29 Oct: "When there is only one message we don't want this bar." The rail shows from the second prompt.
// As in the ChatGPT app, the rail appears from four prompts (specs/chatgpt-chat-style.md; 29 Oct, Masih: "I explicitly told
// you to create a parity of chatgpt app ... the spaces, distances, etc. should be exactly like that").
// R24: a hover card never covers text; here, the live "Working" row at the foot of a running chat.
test('the hover card stays above the live Working row', async () => {
  // The fixture runs turn t4, so it is the last of the 24.
  const chat = Array.from({ length: 24 }, (_, i) => [i === 23 ? 't4' : `p${i + 1}`, `Prompt ${i + 1}.`, `Reply ${i + 1}, which runs to a second line of preview so the card has its usual height.`]);
  const f = await fixture({ chat, running: true, height: 560, routes: { '/api/threads/chat-a/prompts': () => indexOf(chat) } });
  try {
    await f.open('chat-a');
    const working = f.page.locator('.turn-working[role="status"]').last();
    await working.waitFor();
    await f.page.locator('.chat-scroll').evaluate(element => element.scrollTo({ top: element.scrollHeight }));
    const marks = marksOf(f.page);
    await marks.last().hover();
    const card = f.page.locator('.prompt-preview');
    await card.waitFor();
    await f.page.waitForTimeout(100);
    const [c, w] = [await card.boundingBox(), await working.boundingBox()];
    assert.ok(c.y + c.height <= w.y, `card bottom ${c.y + c.height} stays above the Working row's top ${w.y}`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a later loaded-tick click wins while an older page is arriving', async () => {
  const chat = Array.from({ length: 5 }, (_, index) => [`t${index + 1}`, `Prompt ${index + 1}.`, `Answer ${index + 1}.\n\n${'Long explanation.\n\n'.repeat(18)}`]);
  let release, requested;
  const arriving = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  const thread = { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const entries = chat.map(([turnId, text, reply]) => [
    { turnId, item: { id: `u-${turnId}`, type: 'userMessage', content: [{ type: 'text', text }] } },
    { turnId, item: { id: `a-${turnId}`, type: 'agentMessage', text: reply } },
  ]);
  const f = await fixture({ chat, width: 1280, height: 700, routes: {
    '/api/threads/chat-a': async (_body, url) => {
      if (url.searchParams.has('cursor')) { requested(); await arriving; return { thread, data: entries.slice(0, 3).flat().reverse(), nextCursor: null }; }
      return { thread, data: entries.slice(3).flat().reverse(), nextCursor: 'older' };
    },
    '/api/threads/chat-a/prompts': () => indexOf(chat),
  } });
  try {
    await f.open('chat-a');
    await f.page.waitForFunction(() => document.querySelectorAll('[data-slot="prompt-mark"]').length === 5);
    await marksOf(f.page).first().click();
    await started;
    await marksOf(f.page).last().click();
    release();
    await f.page.waitForFunction(() => document.querySelectorAll('section.turn[data-prompt]').length === 5);
    await f.page.waitForFunction(() => {
      const root = document.querySelector('.chat-scroll'), last = root.querySelectorAll('section.turn[data-prompt]')[4];
      return Math.abs(last.getBoundingClientRect().top - root.getBoundingClientRect().top - 16) < 24;
    }, { timeout: 3000 });
    assert.deepEqual(f.errors, []);
  } finally { release(); await f.close(); }
});

test('a retry clears a rejected history request and keeps loaded ticks usable', async () => {
  const chat = Array.from({ length: 5 }, (_, index) => [`t${index + 1}`, `Prompt ${index + 1}.`, `Answer ${index + 1}.\n\n${'Long explanation.\n\n'.repeat(18)}`]);
  const thread = { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const entries = chat.map(([turnId, text, reply]) => [
    { turnId, item: { id: `u-${turnId}`, type: 'userMessage', content: [{ type: 'text', text }] } },
    { turnId, item: { id: `a-${turnId}`, type: 'agentMessage', text: reply } },
  ]);
  let rejected = false;
  const f = await fixture({ staticDir: process.env.ELPIS_RAIL_RENDERER, chat, width: 1280, height: 700, routes: {
    '/api/threads/chat-a': (_body, url) => {
      if (!url.searchParams.has('cursor')) return { thread, data: entries.slice(3).flat().reverse(), nextCursor: 'older' };
      if (!rejected) { rejected = true; return { __http: 400, error: 'This history page was rejected. Try again.' }; }
      return { thread, data: entries.slice(0, 3).flat().reverse(), nextCursor: null };
    },
    '/api/threads/chat-a/prompts': () => indexOf(chat),
  } });
  try {
    await f.open('chat-a');
    await f.page.waitForFunction(() => document.querySelectorAll('[data-slot="prompt-mark"]').length === 5);
    await marksOf(f.page).first().click();
    await f.page.getByText(/This history page was rejected/).waitFor();
    await marksOf(f.page).last().click();
    await f.page.waitForFunction(() => document.querySelectorAll('[data-slot="prompt-mark"]')[4].getAttribute('aria-current') === 'true');
    await marksOf(f.page).first().click();
    await f.page.waitForFunction(() => document.querySelectorAll('section.turn[data-prompt]').length === 5);
    assert.equal(await f.page.getByText(/This history page was rejected/).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('bookmark state persists per chat after reload', async () => {
  const f = await fixture({ width: 1280 });
  try {
    await f.open('chat-a');
    let marks = marksOf(f.page);
    await marks.nth(1).hover();
    await f.page.getByRole('button', { name: 'Bookmark turn' }).click();
    assert.equal(await marks.nth(1).getAttribute('aria-label'), 'Jump to user message 2, bookmarked turn');
    assert.equal(await f.page.getByRole('button', { name: 'Remove bookmark' }).getAttribute('aria-pressed'), 'true');
    await f.page.reload();
    await f.open('chat-a');
    marks = marksOf(f.page);
    assert.equal(await marks.nth(1).getAttribute('aria-label'), 'Jump to user message 2, bookmarked turn');
    assert.equal(await marks.nth(0).getAttribute('aria-label'), 'Jump to user message 1');
    assert.equal(await marks.nth(1).getAttribute('data-bookmarked'), 'true');
    await marks.nth(1).hover();
    await f.page.getByRole('button', { name: 'Remove bookmark' }).click();
    assert.equal(await marks.nth(1).getAttribute('aria-label'), 'Jump to user message 2');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a partially loaded turn pages past steering messages to the exact previewed prompt', async () => {
  // Two older prompts, listed by the index only, bring the rail to the four prompts it needs.
  const chat = [['t0a', 'Earlier prompt A.', 'A.'], ['t0b', 'Earlier prompt B.', 'B.'], ['t1', 'The original prompt.', 'Original answer.'], ['t2', 'The latest prompt.', 'Latest answer.']];
  const thread = { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const user = (turnId, id, text) => ({ turnId, item: { id, type: 'userMessage', content: [{ type: 'text', text }] } });
  const reply = turnId => ({ turnId, item: { id: `a-${turnId}`, type: 'agentMessage', text: `${chat[turnId === 't2' ? 3 : 2][2]}\n\n${'A long explanation.\n\n'.repeat(25)}` } });
  const requested = [];
  const f = await fixture({ chat, width: 1280, height: 700, routes: {
    '/api/threads/chat-a': (_body, url) => {
      const cursor = url.searchParams.get('cursor'); requested.push(cursor);
      if (cursor === 'oldest') return { thread, data: [user('t1', 'original', chat[2][1])], nextCursor: null };
      if (cursor === 'middle') return { thread, data: [user('t1', 'earlier-steer', 'An earlier follow-up.')], nextCursor: 'oldest' };
      return { thread, data: [reply('t2'), user('t2', 'latest', chat[3][1]), reply('t1'), user('t1', 'later-steer', 'A later follow-up.')], nextCursor: 'middle' };
    },
    '/api/threads/chat-a/prompts': () => ({ data: chat.map(([turnId, text, reply], index) => ({ turnId, itemId: ['old-a', 'old-b', 'original', 'latest'][index], text, reply })) }),
  } });
  try {
    await f.open('chat-a');
    await marksOf(f.page).nth(2).hover();
    await f.page.getByText('The original prompt.', { exact: true }).waitFor();
    await marksOf(f.page).nth(2).click();
    await f.page.waitForFunction(() => {
      const root = document.querySelector('.chat-scroll'), bounds = root.getBoundingClientRect();
      return [...root.querySelectorAll('.message.user')].some(node => {
        const rect = node.getBoundingClientRect();
        return node.textContent.trim() === 'The original prompt.' && rect.top >= bounds.top && rect.top < bounds.bottom;
      });
    });
    assert.deepEqual(requested.filter(Boolean), ['middle', 'oldest']);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('205 prompts land inside the settled viewport, including unloaded first and middle prompts', async () => {
  const chat = Array.from({ length: 205 }, (_, index) => [`t${index + 1}`, `Prompt ${index + 1}.`, `Answer ${index + 1}.\n\n${'A paragraph of recorded history for scrolling.\n\n'.repeat(12)}`]);
  const thread = { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const entries = chat.flatMap(([turnId, text, reply]) => [
    { turnId, item: { id: `u-${turnId}`, type: 'userMessage', content: [{ type: 'text', text }] } },
    { turnId, item: { id: `a-${turnId}`, type: 'agentMessage', text: reply } },
  ]);
  const f = await fixture({ chat, width: 1280, height: 700, routes: {
    '/api/threads/chat-a': (_body, url) => {
      const end = url.searchParams.has('cursor') ? Number(url.searchParams.get('cursor')) : entries.length;
      const start = Math.max(0, end - 100);
      return { thread, data: entries.slice(start, end).reverse(), nextCursor: start ? String(start) : null };
    },
    '/api/threads/chat-a/prompts': () => indexOf(chat),
  } });
  try {
    await f.open('chat-a');
    await f.page.waitForFunction(() => document.querySelectorAll('[data-slot="prompt-mark"]').length === 205);
    assert.ok(await f.page.locator('section.turn[data-prompt]').count() < 205);
    for (const position of [204, 102, 0, 204]) {
      await marksOf(f.page).nth(position).click();
      const inView = text => {
        const root = document.querySelector('.chat-scroll'), bounds = root.getBoundingClientRect();
        return [...root.querySelectorAll('.message.user')].some(node => {
          const rect = node.getBoundingClientRect();
          return node.textContent.trim() === text && rect.top >= bounds.top && rect.top < bounds.bottom;
        });
      };
      await f.page.waitForFunction(inView, chat[position][1]);
      await f.page.waitForTimeout(700);
      assert.ok(await f.page.evaluate(inView, chat[position][1]), `prompt ${position + 1} stays visible after lazy turns render`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('large-chat navigation preserves a visited message edit while older turns become visible', async () => {
  const chat = Array.from({ length: 65 }, (_, index) => [`t${index + 1}`, `Prompt ${index + 1}.`, `Answer ${index + 1}.\n\n${'A paragraph of recorded history for scrolling.\n\n'.repeat(12)}`]);
  const f = await fixture({ chat, width: 1280, height: 700, routes: { '/api/threads/chat-a/prompts': () => indexOf(chat) } });
  try {
    await f.open('chat-a');
    const marks = marksOf(f.page);
    await f.page.waitForFunction(() => document.querySelectorAll('[data-slot="prompt-mark"]').length === 65);
    await marks.first().click();
    const first = f.page.locator('.user-turn').filter({ hasText: chat[0][1] });
    await first.getByRole('button', { name: 'Edit message', exact: true }).click();
    const edit = f.page.getByRole('textbox', { name: 'Edited message', exact: true });
    await edit.fill('An unsent revision of the first message.');
    await f.composer.fill('An unrelated composer draft.');
    for (const position of [32, 64, 0]) {
      await marks.nth(position).click();
      await f.page.waitForFunction(({ position, prompt }) => {
        const root = document.querySelector('.chat-scroll'), bounds = root.getBoundingClientRect();
        const turn = root.querySelectorAll('section.turn[data-prompt]')[position];
        const message = turn?.querySelector('[aria-label="Edited message"]') ?? turn?.querySelector('.message.user');
        if (!message || (message.textContent.trim() !== prompt && message.value !== 'An unsent revision of the first message.')) return false;
        const rect = message.getBoundingClientRect();
        return rect.top >= bounds.top && rect.top < bounds.bottom;
      }, { position, prompt: chat[position][1] });
      assert.equal(await edit.inputValue(), 'An unsent revision of the first message.', 'reading another turn never discards the visited editor draft');
    }
    assert.equal(await edit.inputValue(), 'An unsent revision of the first message.');
    assert.equal(await f.composer.inputValue(), 'An unrelated composer draft.');
    assert.equal(f.posts.filter(post => post.path.endsWith('/revert') || post.path.endsWith('/turns')).length, 0, 'navigation never sends either draft');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
