const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('prompt rail opens a readable outline and navigates with pointer and keyboard', async () => {
  const f = await fixture({ width: 1280, height: 700 });
  try {
    await f.open('chat-a');
    const rail = f.page.getByRole('navigation', { name: 'Prompts', exact: true });
    await rail.hover();
    const panel = f.page.getByRole('navigation', { name: 'Prompt list' });
    await panel.waitFor();
    const rows = panel.locator('[data-slot="prompt-row"]');
    assert.deepEqual(await rows.allTextContents(), ['Explain the parser.', 'Rename the lexer.', 'Add tests.', 'Run them.']);
    assert.equal(await rows.nth(3).getAttribute('aria-current'), 'true', 'the prompt being read is marked');

    await rows.first().focus();
    await f.page.keyboard.press('ArrowDown');
    assert.equal(await rows.nth(1).evaluate(node => node === document.activeElement), true, 'Down focuses the next row');
    await f.page.keyboard.press('ArrowUp');
    assert.equal(await rows.first().evaluate(node => node === document.activeElement), true, 'Up focuses the previous row');
    await f.page.keyboard.press('Escape');
    await panel.waitFor({ state: 'detached' });

    await rail.locator('[data-slot="prompt-mark"]').first().focus();
    await panel.waitFor();
    await f.page.mouse.move(1200, 680);
    await panel.waitFor({ state: 'detached' });
    await rail.hover();
    await panel.waitFor();
    const panelBox = await panel.boundingBox();
    const messageBox = await f.page.locator('.chat-content .message.user').first().boundingBox();
    assert.ok(panelBox && messageBox && panelBox.x + panelBox.width <= messageBox.x, 'the outline never covers message text');
    await panel.locator('[data-slot="prompt-row"]').first().click();
    await f.page.waitForFunction(() => {
      const root = document.querySelector('.chat-scroll');
      const first = root?.querySelector('section.turn[data-prompt]');
      return !!root && !!first && Math.abs(first.getBoundingClientRect().top - root.getBoundingClientRect().top - 16) < 24;
    });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('prompt outline includes unloaded turns and loads to a selected older prompt', async () => {
  const chat = Array.from({ length: 5 }, (_, index) => [`t${index + 1}`, `Prompt ${index + 1} asks about the parser.`, `Answer ${index + 1}.\n\n${'Long explanation.\n\n'.repeat(18)}`]);
  chat[0][1] += '\nExtra detail is kept in the message, not the outline row.';
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
    '/api/threads/chat-a/prompts': () => ({ data: chat.map(([turnId, text]) => ({ turnId, text })) }),
  } });
  try {
    await f.open('chat-a');
    assert.equal(await f.page.locator('section.turn[data-prompt]').count(), 2, 'initial history has only two prompts');
    const rail = f.page.getByRole('navigation', { name: 'Prompts', exact: true });
    await rail.hover();
    const panel = f.page.getByRole('navigation', { name: 'Prompt list' });
    const rows = panel.locator('[data-slot="prompt-row"]');
    await f.page.waitForFunction(() => document.querySelectorAll('.prompt-panel [data-slot="prompt-row"]').length === 5);
    assert.equal(await rail.locator('[data-slot="prompt-mark"]').count(), 5, 'ticks represent all prompts');
    assert.deepEqual(await rows.allTextContents(), chat.map(([, text]) => text.split('\n')[0]));
    assert.equal(await rows.nth(4).getAttribute('aria-current'), 'true');
    const load = panel.getByRole('button', { name: 'Load earlier messages' });
    assert.equal(await load.count(), 1, 'the panel offers the existing older-page action');
    assert.equal(await f.page.getByRole('button', { name: 'Load earlier messages' }).count(), 1, 'only one earlier-page action is visible');
    await rows.first().click();
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

test('prompt outline loads one earlier page from its first row', async () => {
  const chat = [['t1', 'Older prompt.', 'Older answer.'], ['t2', 'Recent prompt.', 'Recent answer.'], ['t3', 'Newest prompt.', 'Newest answer.']];
  const thread = { id: 'chat-a', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const older = [{ turnId: 't1', item: { id: 'u-t1', type: 'userMessage', content: [{ type: 'text', text: 'Older prompt.' }] } }, { turnId: 't1', item: { id: 'a-t1', type: 'agentMessage', text: 'Older answer.' } }];
  const recent = chat.slice(1).flatMap(([turnId, text, reply]) => [{ turnId, item: { id: `u-${turnId}`, type: 'userMessage', content: [{ type: 'text', text }] } }, { turnId, item: { id: `a-${turnId}`, type: 'agentMessage', text: reply } }]);
  const f = await fixture({ chat, width: 1280, routes: {
    '/api/threads/chat-a': (_body, url) => url.searchParams.has('cursor') ? { thread, data: [...older].reverse(), nextCursor: null } : { thread, data: [...recent].reverse(), nextCursor: 'older' },
    '/api/threads/chat-a/prompts': () => ({ data: chat.map(([turnId, text]) => ({ turnId, text })) }),
  } });
  try {
    await f.open('chat-a');
    await f.page.getByRole('navigation', { name: 'Prompts', exact: true }).hover();
    const panel = f.page.getByRole('navigation', { name: 'Prompt list' });
    await panel.getByRole('button', { name: 'Load earlier messages' }).click();
    await f.page.waitForFunction(() => document.querySelectorAll('section.turn[data-prompt]').length === 3);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('every dark prompt tick reaches 3:1 contrast against its background', async () => {
  const f = await fixture({ colorScheme: 'dark', width: 1280 });
  try {
    await f.open('chat-a');
    const ratios = await f.page.locator('.prompt-tick i').evaluateAll(nodes => {
      const rgba = value => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d'); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const luminance = channels => channels.reduce((sum, channel, index) => {
        const x = channel / 255, linear = x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        return sum + linear * [0.2126, 0.7152, 0.0722][index];
      }, 0);
      return nodes.map(node => {
        const color = rgba(getComputedStyle(node).backgroundColor);
        const parentColor = getComputedStyle(node.closest('.chat-scroll-wrap')).backgroundColor;
        const backgroundColor = rgba(parentColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : parentColor);
        const composite = color.slice(0, 3).map((channel, index) => channel * color[3] / 255 + backgroundColor[index] * (1 - color[3] / 255));
        const foreground = luminance(composite);
        const background = luminance(backgroundColor.slice(0, 3));
        return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
      });
    });
    assert.ok(ratios.length >= 3);
    assert.ok(ratios.every(ratio => ratio >= 3), `tick contrast must be at least 3:1: ${ratios}`);
  } finally { await f.close(); }
});
