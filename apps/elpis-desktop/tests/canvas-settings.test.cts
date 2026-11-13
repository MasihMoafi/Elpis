const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cts');
const { chooseOption, chooseTheme } = require('./controls.cts');

test('a configured API default keeps its own provider and models in the agent inspector', async () => {
  const f = await openCanvas({ settings: { main: { provider: 'anthropic-credits', model: 'claude-opus-5-5' }, providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'anthropic-credits', displayName: 'Anthropic credits' }] }, providerModels: {
    'anthropic-credits': [{ id: 'claude-opus-5-5', model: 'claude-opus-5-5', displayName: 'Claude Opus 5.5' }, { id: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' }],
  } });
  try {
    await f.node('Quillon · Part 1').click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    assert.equal(await panel.getByRole('combobox', { name: 'Provider', exact: true }).getAttribute('data-value'), 'anthropic-credits');
    const model = panel.getByRole('combobox', { name: 'Model', exact: true });
    await model.click();
    await f.page.getByRole('option', { name: /Claude Sonnet 5\.5/ }).waitFor();
    assert(!(await f.page.getByRole('option').allInnerTexts()).some((row: string) => row.includes('Sol')));
    await f.page.keyboard.press('Escape');
    await chooseOption(model, 'anthropic-credits|claude-sonnet-5-5');
    const saved = await f.saved();
    const agent = saved.nodes.find((node: { type: string; data: { title: string } }) => node.type === 'agent' && node.data.title.startsWith('Quillon · Part 1'));
    assert.equal(agent.data.provider, 'anthropic-credits'); assert.equal(agent.data.model, 'claude-sonnet-5-5');
  } finally { await f.close(); }
});

for (const iso of [false, true]) test(`${iso ? '3D' : '2D'} settings load every provider without opening Add; mouse and keyboard edit the same agent`, async () => {
  const fixture = await openCanvas({ settings: { providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'anthropic-credits', displayName: 'Anthropic API' }] }, providerModels: {
    'anthropic-credits': [{ id: 'opus', model: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'xhigh' }] }, { id: 'sonnet', model: 'claude-sonnet-5', displayName: 'Sonnet 5' }]
  } });
  const { page, canvas } = fixture;
  try {
    if (iso) await canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
    if (iso) await canvas.locator('.iso-node[aria-label^="Quillon · Part 1:"]').click(); else await fixture.node('Quillon · Part 1').click();
    const panel = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    await chooseOption(panel.getByRole('combobox', { name: 'Provider', exact: true }), 'anthropic-credits');
    const model = panel.getByRole('combobox', { name: 'Model', exact: true });
    await model.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('[role=listbox]')));
    await page.keyboard.press('End'); await page.keyboard.press('Enter');
    assert.equal(await model.getAttribute('data-value'), 'anthropic-credits|claude-sonnet-5');
    if (iso) await canvas.locator('.iso-status').getByText('Sonnet 5', { exact: false }).waitFor(); else await fixture.node('Quillon · Part 1').getByText('Sonnet 5', { exact: false }).waitFor();
    await chooseOption(model, 'anthropic-credits|claude-opus-5-5');
    await panel.getByRole('combobox', { name: 'Thinking', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Boolean(document.activeElement?.closest('[role=listbox]')));
    await page.keyboard.press('End'); await page.keyboard.press('Enter');
    await panel.getByRole('textbox', { name: 'Name', exact: true }).fill('Configured answer');
    await panel.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Write the configured answer in src.');
    const saved = await fixture.saved();
    const agent = saved.nodes.find((node: { type: string; data: { title: string } }) => node.data.title === 'Configured answer');
    assert.equal(agent.data.model, 'claude-opus-5-5'); assert.equal(agent.data.provider, 'anthropic-credits'); assert.equal(agent.data.effort, 'xhigh');
    await canvas.getByRole('radio', { name: 'Flat', exact: true }).click();
    await fixture.node('Configured answer').getByText('Opus 5.5', { exact: false }).waitFor();
    for (const theme of ['light']) {
      if (await page.locator('html').evaluate((el: Element) => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(page, theme);
      if (iso) await canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
      await fs.mkdir('/tmp/canvas-rebuild', { recursive: true });
      await page.screenshot({ path: `/tmp/canvas-rebuild/settings-${iso ? 'iso' : 'flat'}-${theme}.png` });
    }
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

// Masih, 13 Nov: "the button be called delete so they all fit". Info, Delete and Done share one row; Done is last.
test('the agent panel shows Info, Delete and Done on one row, Done at the right', async () => {
  const f = await openCanvas({});
  try {
    await f.page.setViewportSize({ width: 1280, height: 900 });
    await f.node('Quillon · Part 1').click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    const remove = panel.getByRole('button', { name: 'Delete agent', exact: true });
    assert.equal((await remove.innerText()).trim(), 'Delete');
    const boxes: { text: string; top: number; right: number }[] = await panel.locator('.canvas-inspector-actions > button').evaluateAll((buttons: Element[]) => buttons.map(button => {
      const r = button.getBoundingClientRect(); return { text: (button as HTMLElement).innerText.trim(), top: Math.round(r.top), right: r.right };
    }));
    assert.deepEqual(boxes.map(box => box.text.split('\n')[0]), ['Info', 'Delete', 'Done']);
    assert.equal(new Set(boxes.map(box => box.top)).size, 1, `one row: ${JSON.stringify(boxes)}`);
    assert.equal(Math.max(...boxes.map(box => box.right)), boxes[2]!.right);
    await remove.click();
    assert.equal(await f.node('Quillon · Part 1').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
