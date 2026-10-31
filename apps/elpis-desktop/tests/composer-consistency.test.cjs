const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

// A wrapped draft grows until its input ceiling; width changes must not clip it or add an early scrollbar.
async function waitForDraftFit(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => {
    const input = document.querySelector('.composer textarea'), style = getComputedStyle(input);
    return input.scrollHeight <= input.clientHeight + 1 || (input.clientHeight >= parseFloat(style.maxHeight) - 1 && style.overflowY === 'auto');
  });
}

// The composer's toolbar is one layout whatever the chat, provider or neighbouring pane: the model button names the model
// only (the provider never rides inside it), the permission label is the full "Approve for me" until the workspace itself
// is narrow, the box's inset follows the workspace's width (not the window's), and nothing leaves the box.
const probe = page => page.evaluate(() => {
  const q = selector => document.querySelector(selector), box = element => element.getBoundingClientRect();
  const workspace = box(q('.workspace-body')), composer = box(q('.composer')), wrap = q('.composer-wrap');
  const visible = element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const controls = [...q('.composer-controls').querySelectorAll('button, select, [role="combobox"]')].filter(visible).map(element => ({ ...box(element).toJSON(), label: element.getAttribute('aria-label') || element.textContent }));
  const approval = box(q('button.composer-pill')), model = box(q('.model-picker-trigger'));
  return {
    shown: composer.width > 0 && composer.height > 0, toolbarWidth: q('.composer-controls').clientWidth, workspace: Math.round(workspace.width), inset: getComputedStyle(wrap).paddingLeft,
    permission: q('.composer-pill .pill-long').offsetParent ? q('.composer-pill .pill-long').textContent : q('.composer-pill .pill-short').textContent,
    model: q('.model-picker-trigger').innerText, providerLabel: !!q('.composer .model-trigger-provider') && visible(q('.composer .model-trigger-provider')),
    leaks: controls.filter(rect => rect.left < composer.left - 0.5 || rect.right > composer.right + 0.5).length,
    page: document.documentElement.scrollWidth > innerWidth,
    rowOffset: Math.abs((approval.top + approval.bottom - model.top - model.bottom) / 2),
    toolbarRows: new Set(controls.map(rect => Math.round((rect.top + rect.bottom) / 2))).size,
    overlaps: controls.flatMap((a, i) => controls.slice(i + 1).filter(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5)).length,
    overlapPairs: controls.flatMap((a, i) => controls.slice(i + 1).filter(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5).map(b => [a.label, b.label, a, b])),
  };
});

for (const colorScheme of ['light', 'dark']) {
  test(`a wide side panel leaves room for the running chat controls (${colorScheme})`, async t => {
    const f = await fixture({ width: 1000, height: 800, colorScheme, running: true });
    t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
    await f.open('chat-a');
    await f.page.keyboard.press('Control+`');
    for (const kind of ['Files', 'Browser tab', 'Context']) {
      await f.page.getByRole('button', { name: 'New side panel tab' }).click();
      await f.page.getByRole('menuitem', { name: kind, exact: true }).click();
      const edge = f.page.getByRole('separator', { name: 'Resize side panel' });
      await edge.focus();
      for (let step = 0; step < 16; step++) await edge.press('ArrowLeft');
      for (const width of [1000, 1100, 1280]) {
        await f.page.setViewportSize({ width, height: 800 });
        await f.page.waitForTimeout(100);
        const m = await probe(f.page), where = `${kind}, ${width}px, ${colorScheme}`;
        assert.equal(m.shown, true, where);
        assert.equal(m.leaks, 0, `${where}: ${JSON.stringify(m)}`);
        assert.equal(m.overlaps, 0, `${where}: ${JSON.stringify(m)}`);
        assert.equal(m.toolbarRows, 1, where);
        assert.equal(m.page, false, where);
        if (process.env.ELPIS_SHOTS && width === 1000) {
          await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
          await f.page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `side-panel-${kind.split(' ')[0].toLowerCase()}-${colorScheme}.png`) });
        }
      }
    }
  });
}

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

for (const colorScheme of ['light', 'dark']) for (const running of [false, true]) test(`composer options and context icon fit at 600, 400 and 320px (${colorScheme}, ${running ? 'running' : 'idle'})`, async t => {
  const f = await fixture({ width: 1100, height: 700, colorScheme, running, routes: {
    '/api/models': () => ({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority', name: 'Fast' }] }] }),
    '/api/voice': () => ({ available: true }),
  } });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  await f.open('chat-a');
  await f.page.getByRole('button', { name: 'Add files and more' }).click();
  await f.page.getByRole('menuitem', { name: /Plan mode/ }).click();
  await f.page.getByRole('button', { name: 'Fast mode', exact: true }).waitFor();
  await f.page.getByRole('button', { name: 'Start voice chat', exact: true }).waitFor();
  const draft = 'Keep this unfinished message while resizing the pane. I still need to add details before sending it to the agent.';
  await f.composer.fill(draft);
  for (const width of [1100, 760, 500, 390]) {
    await f.page.setViewportSize({ width, height: 700 });
    await waitForDraftFit(f.page);
    const m = await probe(f.page);
    assert.ok(m.rowOffset <= 4 || m.toolbarWidth <= 380 && m.toolbarRows <= 2, `controls share a row or wrap at the tight width ${width}px`);
    assert.equal(await f.page.locator('.composer .context-ring').isVisible(), true, 'the context icon stays visible');
    assert.equal(m.leaks, 0, `controls stay inside the composer at ${width}px`);
    assert.equal(m.overlaps, 0, `controls do not overlap at ${width}px`);
  }
  await f.page.setViewportSize({ width: 1100, height: 700 });
  for (const width of [600, 400, 320]) {
    await f.page.locator('.composer').evaluate((element, width) => { element.style.width = `${width}px`; }, width);
    await waitForDraftFit(f.page);
    const floating = await probe(f.page);
    if (process.env.ELPIS_PARITY_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_PARITY_SHOTS}/composer-${colorScheme}-${running ? 'running' : 'idle'}-${width}.png` });
    assert.ok(floating.toolbarRows >= 1 && floating.toolbarRows <= (floating.toolbarWidth <= 380 ? 2 : 1), `controls fit the ${width}px composer without hiding context`);
    assert.ok(floating.rowOffset <= 4 || floating.toolbarWidth <= 380, 'only the tight composer can wrap its control groups');
    const context = f.page.locator('.composer .context-ring');
    assert.equal(await context.count(), 1); assert.equal(await context.isVisible(), true);
    const contextBox = await context.boundingBox(); assert.ok(contextBox.width >= 28 && contextBox.height >= 28, 'the icon keeps its 28px target');
    await context.click();
    await f.page.getByRole('dialog', { name: 'Context window usage', exact: true }).waitFor();
    await f.page.keyboard.press('Escape');
    assert.equal(floating.leaks, 0, 'floating controls stay inside the composer');
    assert.equal(floating.overlaps, 0, `floating controls do not overlap at ${width}px: ${JSON.stringify(floating.overlapPairs)}`);
    assert.equal(await f.composer.inputValue(), draft);
    assert.equal(await f.page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).isVisible(), true, 'thinking/effort stays visible at every composer width');
    assert.equal(await f.page.getByRole('button', { name: running ? 'Send follow-up' : 'Send message', exact: true }).isVisible(), true);
    if (running) assert.equal(await f.page.getByRole('button', { name: 'Stop response', exact: true }).isVisible(), true);
    await f.page.getByRole('button', { name: 'Add files and more', exact: true }).click();
    await f.page.getByRole('menuitem', { name: /Fast mode/ }).waitFor();
    assert.equal(await f.page.getByRole('menuitemradio', { name: 'high', exact: true }).count(), 0, 'effort remains a primary control instead of a duplicate in Plus');
    await f.page.keyboard.press('Escape');
  }
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

for (const model of ['sol', 'claude/claude-sonnet-5-5']) {
  test(`running permission controls stay in the toolbar row: ${model}`, async t => {
    const chat = { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', model, modelProvider: model.startsWith('claude/') ? 'claude' : 'openai', status: { type: 'active' }, desktopAccess: { writable: true, mode: 'direct' } };
    const f = await fixture({ width: 1100, height: 1050, running: true, threads: [chat], routes: {
      '/api/models': () => ({ data: [{ id: model, model, displayName: model }], nextCursor: null }),
      '/api/threads/chat-a/permissions': () => ({ permissions: 'auto' }),
    } });
    t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
    await f.open('chat-a');
    await f.page.locator('.composer-pill').first().click(); await f.page.getByRole('menuitem', { name: /Approve for me/ }).click();
    await f.page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    await f.page.setViewportSize({ width: 500, height: 1050 });
    const p = await probe(f.page);
    assert.equal(p.shown, true);
    assert.equal(p.leaks, 0, JSON.stringify(p));
    assert.equal(p.overlaps, 0, JSON.stringify(p));
    assert.equal(p.toolbarRows, 1, JSON.stringify(p));
    assert.ok(p.rowOffset <= 4, JSON.stringify(p));
    assert.equal(p.permission, 'Auto', JSON.stringify(p));
    assert.equal(p.model, model);
  });
}
