const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const fs = require('node:fs/promises');
const path = require('node:path');

// A wrapped draft grows until its input ceiling; width changes must not clip it or add an early scrollbar.
async function waitForDraftFit(page: { evaluate<T>(fn: () => T): Promise<T>; waitForFunction(fn: () => boolean): Promise<unknown> }) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.waitForFunction(() => {
    const input = document.querySelector<HTMLTextAreaElement>('.composer textarea');
    if (!input) return false;
    const style = getComputedStyle(input);
    return input.scrollHeight <= input.clientHeight + 1 || (input.clientHeight >= parseFloat(style.maxHeight) - 1 && style.overflowY === 'auto');
  });
}

// The composer's toolbar is one layout whatever the chat, provider or neighbouring pane: the model button names the model
// only (the provider never rides inside it), the permission label is the full "Approve for me" until the workspace itself
// is narrow, the box's inset follows the workspace's width (not the window's), and nothing leaves the box.
const probe = (page: { evaluate<T>(fn: () => T): Promise<T> }) => page.evaluate(() => {
  const q = (selector: string): HTMLElement => { const element = document.querySelector<HTMLElement>(selector); if (!element) throw new Error(`Missing ${selector}`); return element; }, box = (element: Element) => element.getBoundingClientRect();
  const workspace = box(q('.workspace-body')), composer = box(q('.composer')), wrap = q('.composer-wrap');
  const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const controls = [...q('.composer-controls').querySelectorAll('button, select, [role="combobox"]')].filter(visible).map(element => ({ ...box(element).toJSON(), label: element.getAttribute('aria-label') || element.textContent }));
  const approval = box(q('button.composer-pill')), model = box(q('.model-picker-trigger'));
  return {
    shown: composer.width > 0 && composer.height > 0, toolbarWidth: q('.composer-controls').clientWidth, workspace: Math.round(workspace.width), inset: getComputedStyle(wrap).paddingLeft,
    permission: q('.composer-pill .pill-long').offsetParent ? q('.composer-pill .pill-long').textContent : q('.composer-pill .pill-short').textContent,
    model: q('.model-picker-trigger').innerText, providerLabel: !!q('.composer .model-trigger-provider') && visible(q('.composer .model-trigger-provider')),
    leaks: controls.filter(rect => rect.left < composer.left - 0.5 || rect.right > composer.right + 0.5).length,
    // A wrapped second row must still sit inside the box: nothing is cut off at the top or bottom.
    cut: controls.filter(rect => rect.top < composer.top - 0.5 || rect.bottom > composer.bottom + 0.5).length,
    page: document.documentElement.scrollWidth > innerWidth,
    rowOffset: Math.abs((approval.top + approval.bottom - model.top - model.bottom) / 2),
    toolbarRows: new Set(controls.map(rect => Math.round((rect.top + rect.bottom) / 2))).size,
    overlaps: controls.flatMap((a, i) => controls.slice(i + 1).filter(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5)).length,
    overlapPairs: controls.flatMap((a, i) => controls.slice(i + 1).filter(b => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5).map(b => [a.label, b.label, a, b])),
  };
});

for (const colorScheme of ['light']) for (const running of [false, true]) test(`composer options and context icon fit at 600, 430, 400 and 320px (${colorScheme}, ${running ? 'running' : 'idle'})`, async (t: import('node:test').TestContext) => {
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
    assert.equal(await f.page.locator('.composer .fast-toggle').isVisible(), m.toolbarWidth > 380, 'Fast stays visible except in a genuinely tight composer');
    assert.equal(m.leaks, 0, `controls stay inside the composer at ${width}px`);
    assert.equal(m.overlaps, 0, `controls do not overlap at ${width}px: ${JSON.stringify(m.overlapPairs)}`);
  }
  await f.page.setViewportSize({ width: 1100, height: 700 });
  // 430: the mid-turn width where the end-aligned right group once spilled under the permissions pill (5 Nov).
  for (const width of [600, 430, 400, 320]) {
    await f.page.locator('.composer').evaluate((element: HTMLElement, width: number) => { element.style.width = `${width}px`; }, width);
    await waitForDraftFit(f.page);
    const floating = await probe(f.page);
    if (process.env.ELPIS_PARITY_SHOTS) await f.page.screenshot({ path: `${process.env.ELPIS_PARITY_SHOTS}/composer-${colorScheme}-${running ? 'running' : 'idle'}-${width}.png` });
    assert.ok(floating.toolbarRows >= 1 && floating.toolbarRows <= (floating.toolbarWidth <= 380 ? 2 : 1), `controls fit the ${width}px composer without hiding context`);
    assert.ok(floating.rowOffset <= 4 || floating.toolbarWidth <= 380, 'only the tight composer can wrap its control groups');
    const context = f.page.locator('.composer .context-ring');
    assert.equal(await context.count(), 1); assert.equal(await context.isVisible(), true);
    assert.equal(await f.page.locator('.composer .fast-toggle').isVisible(), floating.toolbarWidth > 380, 'Fast remains on the toolbar when there is room');
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

test('Fast stays on screen, switched off with its reason, when the chat model offers no Fast tier', async (t: import('node:test').TestContext) => {
  const f = await fixture({ width: 1100, height: 700, colorScheme: 'light', routes: {
    '/api/models': () => ({ data: [{ id: 'sol', model: 'sol', displayName: 'Sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], serviceTiers: [] }], nextCursor: null }),
    '/api/voice': () => ({ available: true }),
  } });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  await f.open('chat-a');
  const fast = f.page.getByRole('button', { name: 'Fast mode', exact: true });
  await fast.waitFor();
  assert.equal(await fast.isDisabled(), true, 'a model without a Fast tier cannot switch Fast on');
  assert.equal(await fast.getAttribute('aria-pressed'), 'false');
  assert.match(await fast.getAttribute('title'), /not offered for this model/);
  await f.page.locator('.composer').evaluate((element: HTMLElement) => { element.style.width = '520px'; });
  await fast.waitFor({ state: 'hidden' });
  await f.page.getByRole('button', { name: 'Add files and more' }).click();
  const item = f.page.getByRole('menuitem', { name: /Fast mode/ });
  await item.waitFor();
  assert.match(await item.innerText(), /Not offered for this model/);
});

// Matilda's error stays in her own place (1 Nov): it sat fixed at the bottom right, over the Send button. Positive: the
// alert shows; negative: it touches neither the composer nor Send, in both themes and a narrow window.
