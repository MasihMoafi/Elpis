// 28 Oct, Masih: "One workflow we need, for instance, is OCR via an agent ... a mother agent of either argon, opus, sonnet,
// sol ... and subagents of gemini-3.8", started seamlessly. Transcribe images builds that team from the folder named in the
// request, with no planner: one Gemini 3.8 Flash reader per six pages, by vision, and one agent joining them in page order.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

// As the engine lists them: the subscriptions' models in its own list, routed by prefix (bridge/workflow-models.mjs).
const MODELS = { extraModels: [{ id: 'opus', model: 'claude/opus', displayName: 'Opus 5.5' }, { id: 'argon', model: 'agy/gemini-4-argon-high', displayName: 'Gemini 4 Argon' }, { id: 'g38', model: 'agy/gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' }] };
const pages = [...Array.from({ length: 8 }, (_, i) => `screen-${i + 1}.png`), 'screen-10.png', 'notes.txt'];

test('Transcribe images builds one Gemini reader per six pages and a join, with Mother on the strongest model', async () => {
  const f = await openCanvas({ folders: ['docs', 'book/pages'], files: { 'book/pages': pages, docs: ['readme.md'] }, ...MODELS });
  try {
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'transcribe');
    const request = f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.fill('Transcribe the screenshots in book/pages into one clean Markdown file');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.nodes ?? []).filter(n => n.type === 'agent').length === 3);
    const saved = await f.saved(), agents = saved.nodes.filter(n => n.type === 'agent');
    assert.deepEqual(agents.map(a => a.data.title.split(' · ')[1]), ['Pages 1–6', 'Pages 7–9', 'Join the pages']);
    assert.ok(agents.every(a => a.data.model === 'agy/gemini-3.8-flash-high' && !a.data.provider), JSON.stringify(agents.map(a => [a.data.model, a.data.provider])));
    assert.match(agents[1].data.instruction, /book\/pages\/screen-7\.png\n- book\/pages\/screen-8\.png\n- book\/pages\/screen-10\.png/, 'pages in natural order');
    assert.match(agents[0].data.instruction, /own vision\. Do not run OCR/);
    assert.equal(agents.some(a => a.data.instruction.includes('notes.txt')), false, 'only images are pages');
    assert.deepEqual(agents[2].data.writeScopes, ['book/pages']);
    assert.match(agents[2].data.instruction, /into book\/pages\/transcription\.md/);
    assert.deepEqual([saved.mother.model, saved.mother.provider], ['claude/opus', null], 'Mother takes the strongest model available');
    assert.equal(f.plans.length, 0, 'the team is built, not planned');
    // The cards and Mother's menu name the subscriptions' models, not their ids.
    assert.match(await f.canvas.locator('.react-flow__node').filter({ hasText: 'Pages 1–6' }).innerText(), /Gemini 3\.8 Flash \(High\)/);
    await f.canvas.locator('.react-flow__node').filter({ hasText: 'MOTHER' }).first().click();
    assert.equal((await f.canvas.getByRole('combobox', { name: 'Her model', exact: true }).innerText()).trim(), 'Opus 5.5');
    // A reader's own panel names its subscription and model (28 Oct: it said OpenAI and agy/gemini-3.8-flash-high), and
    // picking another subscription keeps the route in the model, with no provider.
    await f.canvas.locator('.react-flow__node').filter({ hasText: 'Pages 1–6' }).click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    const provider = panel.getByRole('combobox', { name: 'Provider', exact: true }), model = panel.getByRole('combobox', { name: 'Model', exact: true });
    assert.deepEqual([(await provider.innerText()).trim(), (await model.innerText()).trim()], ['Antigravity', 'Gemini 3.8 Flash (High)']);
    await chooseOption(model, '|agy/gemini-4-argon-high');
    await chooseOption(provider, 'claude/');
    assert.equal((await model.innerText()).trim(), 'Opus 5.5');
    const reader = (await f.saved()).nodes.find(n => n.data.title?.endsWith('Pages 1–6'));
    assert.deepEqual([reader.data.model, reader.data.provider], ['claude/opus', null]);
    // A folder without page images says so and leaves the board alone.
    await request.fill('Transcribe docs');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.canvas.getByText('No page images (PNG, JPG or WebP) in docs.').waitFor();
    assert.equal((await f.saved()).nodes.filter(n => n.type === 'agent').length, 3);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
