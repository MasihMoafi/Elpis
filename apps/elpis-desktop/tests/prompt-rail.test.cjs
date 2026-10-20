const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

const indexOf = chat => ({ data: chat.map(([turnId, text, reply]) => ({ turnId, text, reply })) });
const marksOf = page => page.getByRole('navigation', { name: 'User messages' }).locator('[data-slot="prompt-mark"]');

test('one hovered or focused mark previews only its turn and expands nearby marks', async () => {
  const chat = Array.from({ length: 5 }, (_, index) => [`t${index + 1}`, `Prompt ${index + 1} asks about the parser.`, `Agent reply ${index + 1} starts here.\nThen explains why.\nAnd how.\nThe rest is hidden.`]);
  chat[2][1] += ' This extra detail must be cut off in the one-line title.';
  const f = await fixture({ chat, width: 1280, height: 700, routes: { '/api/threads/chat-a/prompts': () => indexOf(chat) } });
  try {
    await f.open('chat-a');
    const marks = marksOf(f.page);
    await marks.nth(2).hover();
    const card = f.page.locator('.prompt-preview');
    await card.waitFor();
    assert.equal(await card.count(), 1);
    assert.match(await card.innerText(), /Prompt 3 asks about the parser/);
    assert.match(await card.innerText(), /Agent reply 3 starts here/);
    assert.doesNotMatch(await card.innerText(), /Prompt 4|Agent reply 4/);
    assert.equal(await f.page.locator('.prompt-panel').count(), 0);
    const clipped = await card.evaluate(node => {
      const title = node.querySelector('.prompt-preview-title'), reply = node.querySelector('.prompt-preview-reply');
      return { title: title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === 'ellipsis', replyHeight: reply.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(reply).lineHeight) };
    });
    assert.ok(clipped.title, 'the prompt title is one line with an ellipsis');
    assert.ok(clipped.replyHeight <= clipped.lineHeight * 3 + 1, `reply is clamped to three lines: ${JSON.stringify(clipped)}`);
    const aligned = await f.page.evaluate(() => {
      const mark = document.querySelectorAll('[data-slot="prompt-mark"]')[2].getBoundingClientRect();
      const card = document.querySelector('.prompt-preview').getBoundingClientRect();
      return { gap: card.left - mark.right, vertical: Math.abs((card.top + card.bottom - mark.top - mark.bottom) / 2) };
    });
    assert.ok(aligned.gap >= 0 && aligned.gap <= 20, `card sits beside the mark: ${JSON.stringify(aligned)}`);
    assert.ok(aligned.vertical < 10, `card centers on the mark: ${JSON.stringify(aligned)}`);
    await f.page.waitForFunction(() => {
      const widths = [...document.querySelectorAll('[data-slot="prompt-mark"] i')].map(node => node.getBoundingClientRect().width);
      return widths[2] > widths[1] && widths[1] > widths[0];
    });
    const widths = await marks.evaluateAll(nodes => nodes.map(node => node.querySelector('i').getBoundingClientRect().width));
    assert.ok(widths[2] > widths[0], `hovered mark is wider: ${widths}`);
    assert.ok(widths[1] > widths[0], `nearby mark grows: ${widths}`);
    await marks.nth(3).focus();
    assert.match(await card.innerText(), /Prompt 4 asks about the parser/);
    assert.doesNotMatch(await card.innerText(), /Prompt 3/);
    await f.page.keyboard.press('Escape');
    await card.waitFor({ state: 'detached' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('clicking a mark loads an unloaded prompt before scrolling to it', async () => {
  const chat = Array.from({ length: 5 }, (_, index) => [`t${index + 1}`, `Prompt ${index + 1}.`, `Answer ${index + 1}.\n\n${'Long explanation.\n\n'.repeat(18)}`]);
  const thread = { id: 'chat-a', name: 'Fix the parser', preview: 'Fix the parser', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const entries = chat.map(([turnId, prompt, reply]) => [
    { turnId, item: { id: `u-${turnId}`, type: 'userMessage', content: [{ type: 'text', text: prompt }] } },
    { turnId, item: { id: `a-${turnId}`, type: 'agentMessage', text: reply } },
  ]);
  const page = turns => turns.flatMap(index => entries[index]).reverse();
  const requested = [];
  const f = await fixture({ chat, width: 1280, height: 700, routes: {
    '/api/threads/chat-a': (_body, url) => {
      const cursor = url.searchParams.get('cursor'); requested.push(cursor);
      if (cursor === 'older-1') return { thread, data: page([0]), nextCursor: null };
      if (cursor === 'older-2') return { thread, data: page([1, 2]), nextCursor: 'older-1' };
      return { thread, data: page([3, 4]), nextCursor: 'older-2' };
    },
    '/api/threads/chat-a/prompts': () => indexOf(chat),
  } });
  try {
    await f.open('chat-a');
    assert.equal(await f.page.locator('section.turn[data-prompt]').count(), 2);
    const marks = marksOf(f.page);
    await f.page.waitForFunction(() => document.querySelectorAll('[data-slot="prompt-mark"]').length === 5);
    assert.equal(await marks.count(), 5);
    assert.equal(await marks.first().getAttribute('aria-label'), 'Jump to user message 1');
    await marks.first().click();
    await f.page.waitForFunction(() => document.querySelectorAll('section.turn[data-prompt]').length === 5);
    await f.page.waitForFunction(() => {
      const root = document.querySelector('.chat-scroll');
      const first = root?.querySelector('section.turn[data-prompt]');
      return !!root && !!first && Math.abs(first.getBoundingClientRect().top - root.getBoundingClientRect().top - 16) < 24;
    });
    assert.deepEqual(requested.filter(Boolean), ['older-2', 'older-1']);
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

test('preview shows loading, empty, and unavailable reply states', async () => {
  const chat = [['t1', 'First prompt.', 'First answer.'], ['t2', 'Second prompt.', 'Second answer.'], ['t3', 'Third prompt.', 'Third answer.']];
  let resolveIndex;
  const index = new Promise(resolve => { resolveIndex = resolve; });
  const f = await fixture({ chat, width: 1280, routes: { '/api/threads/chat-a/prompts': () => index } });
  try {
    await f.open('chat-a');
    await marksOf(f.page).nth(1).hover();
    const card = f.page.locator('.prompt-preview');
    assert.ok(await card.locator('.skeleton').count() > 0);
    resolveIndex({ data: chat.map(([turnId, text], i) => ({ turnId, text, reply: i === 1 ? '' : 'Answer.' })) });
    await f.page.getByText('(No content)', { exact: true }).waitFor();
    assert.match(await card.innerText(), /Second prompt/);
  } finally { resolveIndex(indexOf(chat)); await f.close(); }

  const failed = await fixture({ chat, width: 1280, routes: { '/api/threads/chat-a/prompts': () => ({ __http: 503, error: 'Unavailable' }) } });
  try {
    await failed.open('chat-a');
    await marksOf(failed.page).nth(1).hover();
    await failed.page.getByText('Preview unavailable', { exact: true }).waitFor();
    assert.deepEqual(failed.errors, []);
  } finally { await failed.close(); }
});

test('rail scrolls a window of marks and card text meets 4.5:1 contrast in both themes', async () => {
  const chat = Array.from({ length: 90 }, (_, index) => [`t${index + 1}`, `Prompt ${index + 1}.`, `Answer ${index + 1}.`]);
  for (const colorScheme of ['light', 'dark']) {
    const f = await fixture({ chat, width: 1280, height: 700, colorScheme, routes: { '/api/threads/chat-a/prompts': () => indexOf(chat) } });
    try {
      await f.open('chat-a');
      const marks = marksOf(f.page);
      await f.page.waitForFunction(() => document.querySelectorAll('[data-slot="prompt-mark"]').length === 90);
      const scroll = await f.page.locator('.prompt-rail-marks').evaluate(node => ({ client: node.clientHeight, content: node.scrollHeight }));
      assert.ok(scroll.content > scroll.client, `rail scrolls in ${colorScheme}: ${JSON.stringify(scroll)}`);
      await marks.nth(45).hover();
      const ratios = await f.page.locator('.prompt-preview').evaluate(card => {
        const rgba = value => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d'); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
          return [...context.getImageData(0, 0, 1, 1).data];
        };
        const luminance = channels => channels.reduce((sum, channel, index) => {
          const x = channel / 255, linear = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
          return sum + linear * [0.2126, 0.7152, 0.0722][index];
        }, 0);
        const background = luminance(rgba(getComputedStyle(card).backgroundColor).slice(0, 3));
        return [...card.querySelectorAll('[data-preview-text]')].map(node => {
          const foreground = luminance(rgba(getComputedStyle(node).color).slice(0, 3));
          return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        });
      });
      assert.equal(ratios.length, 2);
      assert.ok(ratios.every(ratio => ratio >= 4.5), `${colorScheme} card contrast: ${ratios}`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
