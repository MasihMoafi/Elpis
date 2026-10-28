// 28 Oct, Masih: "One workflow we need, for instance, is OCR via an agent ... a mother agent of either argon, opus, sonnet,
// sol ... and subagents of gemini-3.8", started seamlessly. Transcribe images builds that team from the folder named in the
// request, with no planner: one Gemini 3.8 Flash reader per six pages, by vision, and one agent joining them in page order.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

// As the app lists them: each provider its own models (agents-canvas.tsx catalog).
const PROVIDERS = { settings: { providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'anthropic', displayName: 'Anthropic' }, { id: 'google-gemini', displayName: 'Antigravity, your Google sign-in' }] },
  providerModels: { anthropic: [{ id: 'opus', model: 'claude/opus', displayName: 'Opus 5.5' }], 'google-gemini': [{ id: 'argon', model: 'agy/gemini-4-argon-high', displayName: 'Gemini 4 Argon' }, { id: 'g38', model: 'agy/gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' }] } };
const pages = [...Array.from({ length: 8 }, (_, i) => `screen-${i + 1}.png`), 'screen-10.png', 'notes.txt'];

test('Transcribe images builds one Gemini reader per six pages and a join, with Mother on the strongest model', async () => {
  const f = await openCanvas({ folders: ['docs', 'book/pages'], files: { 'book/pages': pages, docs: ['readme.md'] }, ...PROVIDERS });
  try {
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'transcribe');
    const request = f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.fill('Transcribe the screenshots in book/pages into one clean Markdown file');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.nodes ?? []).filter(n => n.type === 'agent').length === 3);
    const saved = await f.saved(), agents = saved.nodes.filter(n => n.type === 'agent');
    assert.deepEqual(agents.map(a => a.data.title.split(' · ')[1]), ['Pages 1–6', 'Pages 7–9', 'Join the pages']);
    assert.ok(agents.every(a => a.data.model === 'agy/gemini-3.8-flash-high' && a.data.provider === 'google-gemini'), JSON.stringify(agents.map(a => [a.data.model, a.data.provider])));
    assert.match(agents[1].data.instruction, /book\/pages\/screen-7\.png\n- book\/pages\/screen-8\.png\n- book\/pages\/screen-10\.png/, 'pages in natural order');
    assert.match(agents[0].data.instruction, /own vision\. Do not run OCR/);
    assert.equal(agents.some(a => a.data.instruction.includes('notes.txt')), false, 'only images are pages');
    assert.deepEqual(agents[2].data.writeScopes, ['book/pages']);
    assert.match(agents[2].data.instruction, /into book\/pages\/transcription\.md/);
    assert.deepEqual([saved.mother.model, saved.mother.provider], ['claude/opus', 'anthropic'], 'Mother takes the strongest model available');
    assert.equal(f.plans.length, 0, 'the team is built, not planned');
    // A folder without page images says so and leaves the board alone.
    await request.fill('Transcribe docs');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.canvas.getByText('No page images (PNG, JPG or WebP) in docs.').waitFor();
    assert.equal((await f.saved()).nodes.filter(n => n.type === 'agent').length, 3);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
