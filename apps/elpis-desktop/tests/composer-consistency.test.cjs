const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

// The composer's toolbar is one layout whatever the chat, provider or neighbouring pane: the model button names the model
// only (the provider never rides inside it), the permission label is the full "Approve for me" until the workspace itself
// is narrow, the box's inset follows the workspace's width (not the window's), and nothing leaves the box.
const probe = page => page.evaluate(() => {
  const q = selector => document.querySelector(selector), box = element => element.getBoundingClientRect();
  const workspace = box(q('.workspace-body')), composer = box(q('.composer')), wrap = q('.composer-wrap');
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const controls = [...q('.composer-controls').querySelectorAll('button, select, [role="combobox"]')].filter(visible).map(box);
  const approval = box(q('button.composer-pill')), model = box(q('.model-picker-trigger'));
  return {
    shown: composer.width > 0 && composer.height > 0, workspace: Math.round(workspace.width), inset: getComputedStyle(wrap).paddingLeft,
    permission: q('.composer-pill .pill-long').offsetParent ? q('.composer-pill .pill-long').textContent : q('.composer-pill .pill-short').textContent,
    model: q('.model-picker-trigger').innerText, providerLabel: !!q('.composer .model-trigger-provider') && visible(q('.composer .model-trigger-provider')),
    leaks: controls.filter(rect => rect.left < composer.left - 0.5 || rect.right > composer.right + 0.5).length,
    page: document.documentElement.scrollWidth > innerWidth,
    rowOffset: Math.abs((approval.top + approval.bottom - model.top - model.bottom) / 2),
    overlaps: controls.flatMap((a, i) => controls.slice(i + 1).filter(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5)).length,
  };
});

for (const model of ['sol', 'claude/claude-sonnet-5-5']) for (const running of [false, true]) {
  test(`toolbar is stable across widths and a browser split (${model}, ${running ? 'running' : 'idle'})`, async t => {
    const provider = model.startsWith('claude/') ? 'claude' : 'openai';
    const chat = { id: 'chat-a', name: 'Fix the parser', preview: 'x', cwd: '/tmp/parity-fixture', model, modelProvider: provider, status: { type: running ? 'active' : 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
    const f = await fixture({ width: 1100, height: 700, colorScheme: 'dark', running, routes: {
      '/api/threads/chat-a/resume': () => ({ thread: chat, activeTurnId: running ? 't4' : null }),
      '/api/threads/chat-a/permissions': () => ({ permissions: 'auto' }),
    } });
    t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
    const { page } = f;
    await f.open('chat-a');
    await page.locator('.composer-pill').first().click(); await page.getByRole('menuitem', { name: /Approve for me/ }).click();
    await page.mouse.click(5, 5);
    for (const split of [false, true]) for (const width of [1100, 760, 500, 390]) {
      await page.setViewportSize({ width, height: 700 });
      if (split && width === 1100) { await page.keyboard.press('Control+`'); await page.getByRole('button', { name: 'New side panel tab' }).click(); await page.getByRole('menuitem', { name: 'Browser tab' }).click(); }
      await page.waitForTimeout(300);
      const m = await probe(page), where = `${split ? 'split' : 'solo'} ${width}px (workspace ${m.workspace}px)`;
      // On a narrow screen the browser replaces the chat pane; its hidden controls are not an on-screen toolbar.
      if (!m.shown) continue;
      assert.equal(m.providerLabel, false, `no provider label inside the model button, ${where}`);
      assert.ok(!/\|/.test(m.model) && !/OpenAI|Anthropic|Configured provider/.test(m.model), `model button names the model only: "${m.model}", ${where}`);
      assert.equal(m.permission, m.workspace > 560 ? 'Approve for me' : 'Auto', `permission label by workspace width, ${where}`);
      assert.equal(m.leaks, 0, `every toolbar control stays inside the box, ${where}`);
      assert.equal(m.overlaps, 0, `toolbar controls do not overlap, ${where}`);
      assert.ok(m.rowOffset <= 4, `approval and model share the bottom row (${m.rowOffset}px apart), ${where}`);
      assert.equal(m.page, false, `no horizontal page overflow, ${where}`);
      assert.equal(m.inset, m.workspace > 640 ? '32px' : m.workspace > 520 ? '22px' : '12px', `box inset by workspace width, ${where}`);
    }
  });
}

test('Ask for approval shares the row with Plan mode in a narrow running chat', async t => {
  const f = await fixture({ width: 1100, height: 700, colorScheme: 'dark', running: true });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  await f.open('chat-a');
  await f.page.getByRole('button', { name: 'Add files and more' }).click();
  await f.page.getByRole('menuitem', { name: /Plan mode/ }).click();
  for (const width of [1100, 760, 500, 390]) {
    await f.page.setViewportSize({ width, height: 700 });
    const m = await probe(f.page);
    assert.ok(m.rowOffset <= 4, `approval and model share a row at ${width}px`);
    assert.equal(m.leaks, 0, `controls stay inside the composer at ${width}px`);
    assert.equal(m.overlaps, 0, `controls do not overlap at ${width}px`);
  }
  await f.page.setViewportSize({ width: 1100, height: 700 });
  await f.page.locator('.composer').evaluate(element => { element.style.width = '400px'; });
  const floating = await probe(f.page);
  assert.ok(floating.rowOffset <= 4, 'the narrow floating composer keeps approval on the same row');
  assert.equal(floating.leaks, 0, 'floating controls stay inside the composer');
  assert.equal(floating.overlaps, 0, 'floating controls do not overlap');
  });

test('active composer controls keep a clear gap at the reported window width', async t => {
  const chat = { id: 'chat-a', name: 'Fix the parser', preview: 'x', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'active' }, desktopAccess: { writable: true, mode: 'direct' } };
  const f = await fixture({ width: 1067, height: 700, colorScheme: 'dark', running: true, routes: {
    '/api/threads/chat-a/resume': () => ({ thread: chat, activeTurnId: 't4' }),
    '/api/threads/chat-a/permissions': () => ({ permissions: 'auto' }),
  } });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  await f.open('chat-a');
  await f.page.getByLabel('Message Elpis').pressSequentially('Keep this follow-up ready');
  const gap = async (left, right) => {
    const a = await f.page.locator(left).boundingBox(), b = await f.page.locator(right).boundingBox();
    assert.ok(a && b, `both ${left} and ${right} are visible`);
    return b.x - (a.x + a.width);
  };
  assert.ok(await gap('.model-picker-trigger', '.composer [aria-label="Reasoning effort"]') >= 8, 'model and effort selectors have breathing room');
  assert.ok(await gap('.stop-button', '.send-button') >= 8, 'stop and follow-up actions have breathing room');

  for (const selector of ['.stop-button', '.send-button']) {
    const box = await f.page.locator(selector).boundingBox();
    await f.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    assert.equal(await f.page.locator(selector).evaluate(element => element.matches(':hover')), true, `${selector} remains an independent mouse target`);
  }
});
