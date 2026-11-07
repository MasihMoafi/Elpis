const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption, chooseTheme, controlValue } = require('./controls.cjs');
type SavedNode = { id: string; type: string; position: { x: number; y: number }; data: { provider?: string; effort?: string | null } };
type Edge = { source: string; target: string };
type WorkingWindow = Window & { __workingSetItem?: (key: string, value: string) => void };
const shots = path.join(os.homedir(), '.cache/elpis-tests/workflows-feedback');
const agent = (id: string, x = 0, y = 0, extra: object = {}) => ({ id, type: 'agent', position: { x, y }, data: { title: id, instruction: `Do ${id}`, model: null, provider: null, effort: null, writeScopes: ['src'], acceptanceCriteria: ['Done'], ...extra } });
const wire = (source: string, target: string, extra: object = {}) => ({ id: `${source}->${target}`, source, target, ...extra });
const selected = (f: { canvas: { locator(selector: string): { evaluateAll(fn: (nodes: HTMLElement[]) => (string | undefined)[]): Promise<(string | undefined)[]> } } }) => f.canvas.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(n => n.dataset.id).sort());

test('explicit workflow flush saves an edit before its debounce and reports a refused save for retry', async () => {
  const f = await openCanvas({ graph: { name: 'Before explicit flush', nodes: [], edges: [] }, desktop: true });
  try {
    await f.page.clock.install(); await f.page.clock.pauseAt(new Date());
    await f.canvas.getByRole('textbox', { name: 'Graph name', exact: true }).fill('Latest workflow verdict 824');
    const flushed = await f.page.evaluate(() => window.__elpisFlushWorkflow?.());
    assert.equal(flushed, true); assert.equal(await f.page.evaluate(() => { const value = window.elpisDesktop?.storage?.getItem('elpis-workflow-draft-v1'); if (value == null) throw Error('Workflow draft is missing'); return JSON.parse(value).name; }), 'Latest workflow verdict 824');
    await f.page.evaluate(() => { const w = window as WorkingWindow, storage = w.elpisDesktop?.storage; if (!storage) throw Error('Desktop storage is unavailable'); w.__workingSetItem = storage.setItem; storage.setItem = () => { throw Error('Private graph storage refused'); }; });
    await f.canvas.getByRole('textbox', { name: 'Graph name', exact: true }).fill('Exact retry workflow verdict 825');
    assert.equal(await f.page.evaluate(() => window.__elpisFlushWorkflow?.()), false);
    await f.page.evaluate(() => { const w = window as WorkingWindow, storage = w.elpisDesktop?.storage; if (!storage || !w.__workingSetItem) throw Error('Desktop storage is unavailable'); storage.setItem = w.__workingSetItem; });
    assert.equal(await f.page.evaluate(() => window.__elpisFlushWorkflow?.()), true);
    assert.equal(await f.page.evaluate(() => { const value = window.elpisDesktop?.storage?.getItem('elpis-workflow-draft-v1'); if (value == null) throw Error('Workflow draft is missing'); return JSON.parse(value).name; }), 'Exact retry workflow verdict 825'); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const middle of [false, true]) test(`bottom + adds only a successor: ${middle ? 'middle agent with folded panel' : 'root agent'}`, async () => {
  const original = { name: 'One successor', nodes: [agent('Start', 260), agent('Existing', 520), { id: 'note', type: 'note', position: { x: 520, y: 140 }, data: { text: 'Keep this space clear' } }, ...(middle ? [agent('Input', 0)] : [])], edges: [wire('Start', 'Existing'), ...(middle ? [wire('Input', 'Start')] : [])] };
  const f = await openCanvas({ graph: original, width: middle ? 1100 : 1440 });
  try {
    if (middle) await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
    const added: string[] = [];
    for (let i = 0; i < 2; i++) {
      await f.fit();
      const source = f.canvas.locator('.react-flow__node[data-id="Start"]');
      await source.hover();
      const plus = source.locator('.agent-node-plus[data-side="bottom"]');
      await plus.click();
      const saved = await f.saved(), beforeIds = new Set([...original.nodes.map(n => n.id), ...added]);
      const made = saved.nodes.filter((n: SavedNode) => !beforeIds.has(n.id) && n.type === 'agent');
      assert.equal(made.length, 1, 'one click adds exactly one agent');
      const first = made[0], originalFirst = original.nodes[0]; assert.ok(first && originalFirst);
      const id = first.id; added.push(id);
      assert.deepEqual(saved.edges.filter((e: Edge) => e.source === id || e.target === id), [wire('Start', id)], 'only Start → new: no inherited inputs, outputs or Mother agent link');
      assert.deepEqual(saved.edges.filter((e: Edge) => !added.includes(e.source) && !added.includes(e.target)), original.edges, 'existing links stay intact');
      assert.deepEqual(saved.nodes.filter((n: SavedNode) => original.nodes.some(old => old.id === n.id)).map((n: SavedNode) => n.position), original.nodes.map(n => n.position), 'quick creation preserves the existing layout');
      assert.ok(first.position.x > originalFirst.position.x, 'the successor occupies the next column');
      assert.deepEqual(await selected(f), [id]);
      const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true }); await panel.waitFor();
      const prompt = panel.getByRole('textbox', { name: 'Prompt', exact: true });
      assert.equal(await prompt.evaluate((el: HTMLElement) => el === document.activeElement), true, 'the new prompt takes the keys');
      await f.page.keyboard.type(`Follow Start ${i + 1}`);
      await f.fit();
      const overlaps = await f.canvas.locator('.react-flow__node-agent, .react-flow__node-note, .react-flow__node-mother').evaluateAll((nodes: HTMLElement[]) => {
        const boxes = nodes.map(n => n.getBoundingClientRect());
        return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
      });
      assert.equal(overlaps, false, 'successors avoid occupied slots, notes and each other');
      assert.match(await plus.getAttribute('title'), /after this one.*only.*this one/i);
      assert.equal(await plus.getAttribute('aria-label'), 'Add an agent after Start');
    }
    await fs.mkdir(`${shots}/plus`, { recursive: true });
    for (const theme of ['light']) {
      if ((await f.page.locator('html').evaluate((el: HTMLElement) => el.classList.contains('dark'))) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      await f.fit();
      if (!middle) { await f.canvas.getByRole('button', { name: /zoom out/i }).click(); await f.page.waitForTimeout(250); }
      await f.page.screenshot({ path: `${shots}/plus/${middle ? 'middle' : 'root'}-${theme}.png` });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('bottom + respects the agent limit without changing links', async () => {
  const original = { name: 'Full board', maxAgents: 2, nodes: [agent('Start', 260), agent('Existing', 520)], edges: [wire('Start', 'Existing')] };
  const f = await openCanvas({ graph: original });
  try {
    await f.fit(); const before = await f.saved(), source = f.canvas.locator('.react-flow__node[data-id="Start"]');
    await source.hover(); await source.locator('.agent-node-plus[data-side="bottom"]').click();
    assert.match(await f.canvas.getByRole('alert').innerText(), /limit of 2 agents/);
    const saved = await f.saved();
    assert.deepEqual(saved.nodes, before.nodes);
    assert.deepEqual(saved.edges, before.edges);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const preserves of [false, true]) test(`delayed provider catalog ${preserves ? 'retains an offered model' : 'chooses its default'}`, async () => {
  const release: { resolve?: (models: { id: string; model: string; displayName: string }[]) => void } = {};
  const delayed = new Promise<{ id: string; model: string; displayName: string }[]>(resolve => { release.resolve = resolve; });
  const f = await openCanvas({ graph: { name: 'Delayed models', nodes: [agent('Answer 1', 0, 0, { model: 'gpt-6.1-sol', provider: 'openai' })], edges: [] }, settings: { providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'shared', displayName: 'Shared models' }, { id: 'delayed', displayName: 'Delayed models' }] }, providerModels: {
    shared: [{ id: 'first', model: 'other-model', displayName: 'Other model' }, { id: 'shared-sol', model: 'gpt-6.1-sol', displayName: 'Shared Sol' }],
    delayed: () => delayed,
  } });
  try {
    await f.node('Answer 1').click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    const provider = panel.getByRole('combobox', { name: 'Provider', exact: true }), model = panel.getByRole('combobox', { name: 'Model', exact: true });
    assert.equal(await controlValue(provider), 'openai', 'explicit main provider aliases the configured provider (listed by its own id since fc2cd0fa6, 2 Nov)');
    await chooseOption(provider, 'shared'); assert.equal(await controlValue(model), 'shared|gpt-6.1-sol', 'an offered model survives a provider change');
    await chooseOption(provider, 'delayed');
    await model.click(); await f.page.getByRole('option').first().waitFor(); assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['Default model']); await f.page.keyboard.press('Escape');
    assert.ok(release.resolve); release.resolve([{ id: 'delayed-default', model: 'delayed-default', displayName: 'Delayed default' }, ...(preserves ? [{ id: 'shared-sol', model: 'gpt-6.1-sol', displayName: 'Shared Sol' }] : [])]);
    const expected = `delayed|${preserves ? 'gpt-6.1-sol' : 'delayed-default'}`;
    await f.page.waitForFunction((expected: string) => document.querySelector('.canvas-side [aria-label="Model"]')?.getAttribute('data-value') === expected, expected);
    assert.equal((await f.saved()).nodes.find((n: SavedNode) => n.id === 'Answer 1').data.provider, 'delayed');
    await model.click(); await f.page.getByRole('option').first().waitFor(); assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['Default model', 'Delayed default', ...(preserves ? ['Shared Sol'] : [])]); await f.page.keyboard.press('Escape');
    assert.deepEqual(f.errors, []);
  } finally { release.resolve?.([]); await f.close(); }
});

test('keep-flow reconnects the implicit Mother agent and does not duplicate an existing survivor link', async () => {
  const f = await openCanvas({ graph: { name: 'Mother agent flow', nodes: ['Answer 3', 'Output 1', 'Output 2'].map((id, i) => agent(id, i * 260)), edges: [wire('Answer 3', 'Output 1'), wire('Answer 3', 'Output 2')] } });
  try {
    await f.fit(); await f.node('Answer 3').click(); await f.page.keyboard.press('Control+Delete');
    await f.canvas.getByRole('status').filter({ hasText: 'Deleted Answer 3 · kept 2 links' }).waitFor();
    assert.equal(await f.canvas.locator('.canvas-edge-mother').count(), 2);
    assert.equal((await f.saved()).edges.length, 0, 'Mother agent remains implicit');
  } finally { await f.close(); }
});

for (const iso of [false, true]) test(`${iso ? 'isometric' : 'flat'} provider filters models through inspector and Dashboard settings`, async () => {
  const f = await openCanvas({ graph: { name: 'Provider models', nodes: [agent('Answer 1', 0, 0, { model: 'gpt-6.1-sol', effort: 'high' })], edges: [] }, settings: { providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'anthropic-credits', displayName: 'Anthropic API' }] }, providerModels: { 'anthropic-credits': [{ id: 'opus', model: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'sonnet', model: 'claude-sonnet-5', displayName: 'Sonnet 5' }] } });
  try {
    if (iso) await f.canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
    const node = iso ? f.canvas.locator('.iso-node[data-kind="agent"]') : f.node('Answer 1');
    await node.click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    const provider = panel.getByRole('combobox', { name: 'Provider', exact: true }), model = panel.getByRole('combobox', { name: 'Model', exact: true });
    await chooseOption(provider, 'anthropic-credits');
    await model.click();
    await f.page.getByRole('option').first().waitFor();
    assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['Default model', 'Opus 5.5', 'Sonnet 5'], 'no OpenAI choices under Anthropic');
    await f.page.keyboard.press('Escape'); assert.equal(await controlValue(model), 'anthropic-credits|claude-opus-5-5');
    assert.equal((await f.saved()).nodes.find((n: SavedNode) => n.id === 'Answer 1').data.effort, null);
    await chooseOption(model, 'anthropic-credits|claude-sonnet-5');
    await chooseOption(model, ''); assert.equal(await controlValue(model), 'anthropic-credits|claude-opus-5-5', 'Default model belongs to the selected provider');
    await chooseOption(model, 'anthropic-credits|claude-sonnet-5');
    await node.click(); await f.page.keyboard.press('Enter');
    const dashboard = f.canvas.getByRole('dialog', { name: 'Answer 1 info', exact: true });
    await dashboard.getByText('Sonnet 5', { exact: true }).waitFor();
    await dashboard.getByRole('button', { name: 'Settings', exact: true }).click();
    await chooseOption(provider, 'openai'); assert.equal(await controlValue(model), 'openai|gpt-6.1-sol', 'configured main default wins over first catalog item');
    await model.click(); await f.page.getByRole('option').first().waitFor(); assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['Default model', 'Luna 6', 'Sol 6.1']); await f.page.keyboard.press('Escape');
    await fs.mkdir(shots, { recursive: true });
    for (const theme of ['light']) {
      if ((await f.page.locator('html').evaluate((el: HTMLElement) => el.classList.contains('dark'))) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      await chooseOption(provider, 'anthropic-credits'); await model.click(); await f.page.getByRole('option').first().waitFor();
      await f.page.screenshot({ path: `${shots}/${iso ? 'isometric' : 'flat'}-panel-${theme}.png` }); await f.page.keyboard.press('Escape');
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
