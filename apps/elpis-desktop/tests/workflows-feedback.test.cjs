const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption, chooseTheme, controlValue } = require('./controls.cjs');
const shots = '/home/masih/.cache/elpis-tests/workflows-feedback';
const agent = (id, x = 0, y = 0, extra = {}) => ({ id, type: 'agent', position: { x, y }, data: { title: id, instruction: `Do ${id}`, model: null, provider: null, effort: null, writeScopes: ['src'], acceptanceCriteria: ['Done'], ...extra } });
const wire = (source, target, extra = {}) => ({ id: `${source}->${target}`, source, target, ...extra });
const selected = f => f.canvas.locator('.react-flow__node.selected').evaluateAll(nodes => nodes.map(n => n.dataset.id).sort());

test('explicit workflow flush saves an edit before its debounce and reports a refused save for retry', async () => {
  const f = await openCanvas({ graph: { name: 'Before explicit flush', nodes: [], edges: [] }, desktop: true });
  try {
    await f.page.clock.install(); await f.page.clock.pauseAt(new Date());
    await f.canvas.getByRole('textbox', { name: 'Graph name', exact: true }).fill('Latest workflow verdict 824');
    const flushed = await f.page.evaluate(() => window.__elpisFlushWorkflow?.());
    assert.equal(flushed, true); assert.equal(await f.page.evaluate(() => JSON.parse(window.elpisDesktop.storage.getItem('elpis-workflow-draft-v1')).name), 'Latest workflow verdict 824');
    await f.page.evaluate(() => { window.__workingSetItem = window.elpisDesktop.storage.setItem; window.elpisDesktop.storage.setItem = () => { throw Error('Private graph storage refused'); }; });
    await f.canvas.getByRole('textbox', { name: 'Graph name', exact: true }).fill('Exact retry workflow verdict 825');
    assert.equal(await f.page.evaluate(() => window.__elpisFlushWorkflow()), false);
    await f.page.evaluate(() => { window.elpisDesktop.storage.setItem = window.__workingSetItem; });
    assert.equal(await f.page.evaluate(() => window.__elpisFlushWorkflow()), true);
    assert.equal(await f.page.evaluate(() => JSON.parse(window.elpisDesktop.storage.getItem('elpis-workflow-draft-v1')).name), 'Exact retry workflow verdict 825'); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const middle of [false, true]) test(`bottom + adds only a successor: ${middle ? 'middle agent with folded panel' : 'root agent'}`, async () => {
  const original = { name: 'One successor', nodes: [agent('Start', 260), agent('Existing', 520), { id: 'note', type: 'note', position: { x: 520, y: 140 }, data: { text: 'Keep this space clear' } }, ...(middle ? [agent('Input', 0)] : [])], edges: [wire('Start', 'Existing'), ...(middle ? [wire('Input', 'Start')] : [])] };
  const f = await openCanvas({ graph: original, width: middle ? 1100 : 1440 });
  try {
    if (middle) await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).click();
    const added = [];
    for (let i = 0; i < 2; i++) {
      await f.fit();
      const source = f.canvas.locator('.react-flow__node[data-id="Start"]');
      await source.hover();
      const plus = source.locator('.agent-node-plus[data-side="bottom"]');
      await plus.click();
      const saved = await f.saved(), beforeIds = new Set([...original.nodes.map(n => n.id), ...added]);
      const made = saved.nodes.filter(n => !beforeIds.has(n.id) && n.type === 'agent');
      assert.equal(made.length, 1, 'one click adds exactly one agent');
      const id = made[0].id; added.push(id);
      assert.deepEqual(saved.edges.filter(e => e.source === id || e.target === id), [wire('Start', id)], 'only Start → new: no inherited inputs, outputs or Mother link');
      assert.deepEqual(saved.edges.filter(e => !added.includes(e.source) && !added.includes(e.target)), original.edges, 'existing links stay intact');
      assert.deepEqual(saved.nodes.filter(n => original.nodes.some(old => old.id === n.id)).map(n => n.position), original.nodes.map(n => n.position), 'quick creation preserves the existing layout');
      assert.ok(made[0].position.x > original.nodes[0].position.x, 'the successor occupies the next column');
      assert.deepEqual(await selected(f), [id]);
      const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true }); await panel.waitFor();
      const prompt = panel.getByRole('textbox', { name: 'Prompt', exact: true });
      assert.equal(await prompt.evaluate(el => el === document.activeElement), true, 'the new prompt takes the keys');
      await f.page.keyboard.type(`Follow Start ${i + 1}`);
      await f.fit();
      const overlaps = await f.canvas.locator('.react-flow__node-agent, .react-flow__node-note, .react-flow__node-mother').evaluateAll(nodes => {
        const boxes = nodes.map(n => n.getBoundingClientRect());
        return boxes.some((a, i) => boxes.slice(i + 1).some(b => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
      });
      assert.equal(overlaps, false, 'successors avoid occupied slots, notes and each other');
      assert.match(await plus.getAttribute('title'), /after this one.*only.*this one/i);
      assert.equal(await plus.getAttribute('aria-label'), 'Add an agent after Start');
    }
    await fs.mkdir(`${shots}/plus`, { recursive: true });
    for (const theme of ['light', 'dark']) {
      if ((await f.page.locator('html').evaluate(el => el.classList.contains('dark'))) !== (theme === 'dark')) await chooseTheme(f.page, theme);
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

async function drag(f, from, to, { shift = false, shot } = {}) {
  if (shift) await f.page.keyboard.down('Shift');
  await f.page.mouse.move(from.x, from.y); await f.page.mouse.down();
  await f.page.mouse.move(to.x, to.y, { steps: 12 });
  if (shot) await f.page.screenshot({ path: `${shots}/${shot}.png` });
  await f.page.mouse.up(); if (shift) await f.page.keyboard.up('Shift');
}

test('AutoCAD window contains, crossing touches, Shift adds notes, and drags never move nodes', async () => {
  const f = await openCanvas({ graph: { name: 'AutoCAD selection', nodes: [agent('Answer 1'), agent('Answer 2', 0, 220), { id: 'note', type: 'note', position: { x: 300, y: 180 }, data: { text: 'Selection note' } }], edges: [] } });
  try {
    await fs.mkdir(shots, { recursive: true }); await f.fit();
    const initial = (await f.saved()).nodes.map(n => n.position);
    const a = await f.node('Answer 1').boundingBox();
    const left = { x: a.x - 14, y: a.y - 14 }, partial = { x: a.x + a.width / 2, y: a.y + a.height + 14 };
    await drag(f, left, partial); assert.deepEqual(await selected(f), [], 'a window rejects partial overlap');
    await drag(f, partial, left); assert.deepEqual(await selected(f), ['Answer 1'], 'a crossing accepts partial overlap');
    await drag(f, left, { x: a.x + a.width + 14, y: a.y + a.height + 14 }); assert.deepEqual(await selected(f), ['Answer 1'], 'a window accepts full containment');
    const note = await f.canvas.locator('.react-flow__node-note').boundingBox();
    await drag(f, { x: note.x + note.width + 14, y: note.y - 14 }, { x: note.x + note.width / 2, y: note.y + note.height + 14 }, { shift: true });
    assert.deepEqual(await selected(f), ['Answer 1', 'note'], 'Shift crossing adds a touched note');
    await drag(f, { x: note.x - 14, y: note.y - 14 }, { x: note.x + note.width + 14, y: note.y + note.height + 14 });
    assert.deepEqual(await selected(f), ['note'], 'window selects enclosed notes and replaces without Shift');
    for (const theme of ['light', 'dark']) {
      if ((await f.page.locator('html').evaluate(el => el.classList.contains('dark'))) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      const box = await f.node('Answer 1').boundingBox();
      const tints = [];
      for (const crossing of [false, true]) {
        const l = { x: box.x - 14, y: box.y - 14 }, r = { x: box.x + box.width + 14, y: box.y + box.height + 14 };
        await f.page.mouse.move((crossing ? r : l).x, (crossing ? r : l).y); await f.page.mouse.down();
        await f.page.mouse.move((crossing ? l : r).x, (crossing ? l : r).y, { steps: 12 });
        const style = await f.canvas.locator('.canvas-selection').evaluate(el => ({ border: getComputedStyle(el).borderStyle, color: getComputedStyle(el).backgroundColor }));
        assert.equal(style.border, crossing ? 'dashed' : 'solid');
        tints.push(style.color);
        await f.page.screenshot({ path: `${shots}/${theme}-${crossing ? 'crossing' : 'window'}.png` });
        await f.page.mouse.up();
      }
      assert.notEqual(tints[0], tints[1], `${theme}: window and crossing have different tints`);
    }
    assert.match(await f.canvas.locator('.canvas-toolbar').innerText(), /AutoCAD/);
    assert.deepEqual((await f.saved()).nodes.map(n => n.position), initial, 'selection leaves positions intact');
    await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).click(); await f.fit();
    const closed = await f.node('Answer 1').boundingBox();
    await f.page.mouse.move(closed.x - 14, closed.y - 14); await f.page.mouse.down();
    await f.page.mouse.move(closed.x + closed.width + 14, closed.y + closed.height + 14, { steps: 12 });
    assert.equal(await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).getAttribute('aria-pressed'), 'false', 'the inspector does not resize the board during a drag');
    await f.page.mouse.up(); await f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true }).waitFor();
    await f.fit();
    const cancel = await f.node('Answer 1').boundingBox();
    await f.page.mouse.move(cancel.x - 14, cancel.y - 14); await f.page.mouse.down();
    await f.page.mouse.move(cancel.x + cancel.width / 2, cancel.y + cancel.height + 14, { steps: 12 });
    await f.page.keyboard.press('Escape'); await f.page.mouse.up();
    assert.equal(await f.canvas.locator('.canvas-selection').count(), 0, 'Escape cancels the drag');
    const pane = await f.canvas.locator('.react-flow__pane').boundingBox();
    await f.page.mouse.dblclick(pane.x + 25, pane.y + 25); await f.agentCount(3, 'double-click creation still works');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const preserves of [false, true]) test(`delayed provider catalog ${preserves ? 'retains an offered model' : 'chooses its default'}`, async () => {
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const f = await openCanvas({ graph: { name: 'Delayed models', nodes: [agent('Answer 1', 0, 0, { model: 'gpt-6.1-sol', provider: 'openai' })], edges: [] }, settings: { providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'shared', displayName: 'Shared models' }, { id: 'delayed', displayName: 'Delayed models' }] }, providerModels: {
    shared: [{ id: 'first', model: 'other-model', displayName: 'Other model' }, { id: 'shared-sol', model: 'gpt-6.1-sol', displayName: 'Shared Sol' }],
    delayed: () => delayed,
  } });
  try {
    await f.node('Answer 1').click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    const provider = panel.getByRole('combobox', { name: 'Provider', exact: true }), model = panel.getByRole('combobox', { name: 'Model', exact: true });
    assert.equal(await controlValue(provider), '', 'explicit main provider aliases the configured provider');
    await chooseOption(provider, 'shared'); assert.equal(await controlValue(model), 'shared|gpt-6.1-sol', 'an offered model survives a provider change');
    await chooseOption(provider, 'delayed');
    await model.click(); await f.page.getByRole('option').first().waitFor(); assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['Default model']); await f.page.keyboard.press('Escape');
    release([{ id: 'delayed-default', model: 'delayed-default', displayName: 'Delayed default' }, ...(preserves ? [{ id: 'shared-sol', model: 'gpt-6.1-sol', displayName: 'Shared Sol' }] : [])]);
    const expected = `delayed|${preserves ? 'gpt-6.1-sol' : 'delayed-default'}`;
    await f.page.waitForFunction(expected => document.querySelector('.canvas-side [aria-label="Model"]')?.getAttribute('data-value') === expected, expected);
    assert.equal((await f.saved()).nodes.find(n => n.id === 'Answer 1').data.provider, 'delayed');
    await model.click(); await f.page.getByRole('option').first().waitFor(); assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['Default model', 'Delayed default', ...(preserves ? ['Shared Sol'] : [])]); await f.page.keyboard.press('Escape');
    assert.deepEqual(f.errors, []);
  } finally { release([]); await f.close(); }
});

test('keep-flow bridges alongside and feedback chains, reports links, Undo restores, plain Delete does not bridge', async () => {
  const f = await openCanvas({ graph: { name: 'Keep every link', nodes: ['Input', 'Answer 3', 'Middle', 'Output'].map((id, i) => agent(id, i * 260)), edges: [wire('Input', 'Answer 3', { kind: 'alongside' }), wire('Answer 3', 'Middle', { feedback: true, label: 'Result' }), wire('Middle', 'Output')] } });
  try {
    await f.fit(); const original = await f.saved();
    await f.node('Answer 3').click(); await f.node('Middle').click({ modifiers: ['Shift'] });
    await f.page.keyboard.press('Control+Delete');
    const graph = await f.saved();
    const bridged = graph.edges.find(e => e.source === 'Input' && e.target === 'Output');
    assert.ok(bridged, 'every link kind participates across multiple deleted agents');
    assert.equal(bridged.kind, 'alongside'); assert.equal(bridged.feedback, true);
    assert.equal(new Set(graph.edges.map(e => `${e.source}->${e.target}`)).size, graph.edges.length);
    assert.ok(graph.edges.every(e => e.source !== e.target));
    await f.canvas.getByRole('status').filter({ hasText: /Deleted.*kept \d+ links?/ }).waitFor();
    await f.canvas.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.deepEqual((await f.saved()).edges, original.edges);
    await f.fit(); await f.node('Answer 3').click(); await f.page.keyboard.press('Delete');
    assert.ok(!(await f.saved()).edges.some(e => e.source === 'Input' && e.target === 'Middle'), 'plain Delete does not bridge');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('keep-flow reconnects the implicit Mother and does not duplicate an existing survivor link', async () => {
  const f = await openCanvas({ graph: { name: 'Mother flow', nodes: ['Answer 3', 'Output 1', 'Output 2'].map((id, i) => agent(id, i * 260)), edges: [wire('Answer 3', 'Output 1'), wire('Answer 3', 'Output 2')] } });
  try {
    await f.fit(); await f.node('Answer 3').click(); await f.page.keyboard.press('Control+Delete');
    await f.canvas.getByRole('status').filter({ hasText: 'Deleted Answer 3 · kept 2 links' }).waitFor();
    assert.equal(await f.canvas.locator('.canvas-edge-mother').count(), 2);
    assert.equal((await f.saved()).edges.length, 0, 'Mother remains implicit');
  } finally { await f.close(); }
});

for (const iso of [false, true]) test(`${iso ? 'isometric' : 'flat'} provider filters models through inspector and Dashboard settings`, async () => {
  const f = await openCanvas({ graph: { name: 'Provider models', nodes: [agent('Answer 1', 0, 0, { model: 'gpt-6.1-sol', effort: 'high' })], edges: [] }, settings: { providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'anthropic-credits', displayName: 'Anthropic API' }] }, providerModels: { 'anthropic-credits': [{ id: 'opus', model: 'claude-opus-5-5', displayName: 'Opus 5.5' }, { id: 'sonnet', model: 'claude-sonnet-5', displayName: 'Sonnet 5' }] } });
  try {
    if (iso) await f.canvas.getByRole('button', { name: 'Isometric', exact: true }).click();
    const node = iso ? f.canvas.locator('.iso-node[data-kind="agent"]') : f.node('Answer 1');
    await node.click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    const provider = panel.getByRole('combobox', { name: 'Provider', exact: true }), model = panel.getByRole('combobox', { name: 'Model', exact: true });
    await chooseOption(provider, 'anthropic-credits');
    await model.click();
    await f.page.getByRole('option').first().waitFor();
    assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['Default model', 'Opus 5.5', 'Sonnet 5'], 'no OpenAI choices under Anthropic');
    await f.page.keyboard.press('Escape'); assert.equal(await controlValue(model), 'anthropic-credits|claude-opus-5-5');
    assert.equal((await f.saved()).nodes.find(n => n.id === 'Answer 1').data.effort, null);
    await chooseOption(model, 'anthropic-credits|claude-sonnet-5');
    await chooseOption(model, ''); assert.equal(await controlValue(model), 'anthropic-credits|claude-opus-5-5', 'Default model belongs to the selected provider');
    await chooseOption(model, 'anthropic-credits|claude-sonnet-5');
    await node.click(); await f.page.keyboard.press('Enter');
    const dashboard = f.canvas.getByRole('dialog', { name: 'Answer 1 dashboard', exact: true });
    await dashboard.getByText('Sonnet 5', { exact: true }).waitFor();
    await dashboard.getByRole('button', { name: 'Settings', exact: true }).click();
    await chooseOption(provider, ''); assert.equal(await controlValue(model), '|gpt-6.1-sol', 'configured main default wins over first catalog item');
    await model.click(); await f.page.getByRole('option').first().waitFor(); assert.deepEqual(await f.page.getByRole('option').allTextContents(), ['Default model', 'Luna 6', 'Sol 6.1']); await f.page.keyboard.press('Escape');
    await fs.mkdir(shots, { recursive: true });
    for (const theme of ['light', 'dark']) {
      if ((await f.page.locator('html').evaluate(el => el.classList.contains('dark'))) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      await chooseOption(provider, 'anthropic-credits'); await model.click(); await f.page.getByRole('option').first().waitFor();
      await f.page.screenshot({ path: `${shots}/${iso ? 'isometric' : 'flat'}-panel-${theme}.png` }); await f.page.keyboard.press('Escape');
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
