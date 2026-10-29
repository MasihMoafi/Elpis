// 28 Oct, Masih: "we should expand the workflows; the /logo workflow". 29 Oct: "four agents is too extra for this, one mother and
// one child (the image generator which is a tool-call for the model) would do the job. use sol high or med in fast mode." Logo is
// one agent, with no check and no planner, for the brand in the request box (or else the project's name).
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

const OPUS = { id: 'opus', model: 'claude/opus', displayName: 'Opus 5.5' };
// Launch list (27 Oct): the tracer comes from the environment Elpis starts with, defaulting to this workstation's layout under $HOME.
const TRACE = 'SVG_STUDIO_MODULE="${SVG_STUDIO_MODULE:-$HOME/Desktop/p/svg/mcp-server/dist/vectorize.js}" node "${ELPIS_LOGO_SCRIPTS:-$HOME/Desktop/p/skills/logo/scripts}/trace.mjs"';

test('Logo is one Sol agent in Fast mode that draws three directions and traces each, with no check and no planner', async () => {
  const f = await openCanvas({ desktop: true, files: { '.': ['README.md'] }, extraModels: [OPUS] });
  try {
    await f.page.evaluate(() => { window.__opened = []; window.elpisDesktop.openFile = async target => { window.__opened.push(target); }; });
    await f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true }).fill('Rustidian');
    const pattern = f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true });
    await pattern.click();
    assert.deepEqual((await f.page.getByRole('option').allInnerTexts()).slice(0, 3).map(text => text.trim()), ['Transcribe images', 'Translate', 'Logo'], 'the ready-made workflows are on top');
    await f.page.keyboard.press('Escape');
    await chooseOption(pattern, 'logo');
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.result === 'logo/1.svg');
    const saved = await f.saved(), agents = saved.nodes.filter(n => n.type === 'agent');
    assert.equal(agents.length, 1, 'one agent: its image tool is the only helper');
    const [logo] = agents;
    assert.deepEqual([logo.data.model, logo.data.provider ?? null, logo.data.effort, logo.data.fast, logo.data.check], ['gpt-6.1-sol', null, 'medium', true, false]);
    assert.match(logo.data.instruction, /Rustidian/);
    assert.match(logo.data.instruction, /image generation tool/);
    assert.ok(['logo/1.png', '2.png', '3.png', 'logo/prompts.md', 'logo/1.svg'].every(name => logo.data.instruction.includes(name)), 'three numbered directions, their prompts and their SVGs');
    // 29 Oct (Masih: "What breaks it is bad image prompting"): prompts as in the approved collection ones, one concrete subject.
    assert.match(logo.data.instruction, /one concrete, recognizable subject/i);
    assert.match(logo.data.instruction, /part by part/i);
    assert.match(logo.data.instruction, /never abstract planes, plain letters or generic geometry/i);
    assert.match(logo.data.instruction, /one flat ink colour \(a hex code\) on genuine transparency/i);
    assert.ok(logo.data.instruction.includes(TRACE), 'the MCP servers are off, so it runs the skill\'s CLI wrapper');
    assert.match(logo.data.instruction, /if node cannot find vectorize\.js or trace\.mjs, stop and say SVG Studio is not set up/i, 'a missing tracer is reported, not worked around');
    assert.match(logo.data.instruction, /leave the choice to the person/);
    assert.ok(!/\/home\//.test(logo.data.instruction), 'no instruction names one person\'s home folder');
    assert.deepEqual(logo.data.writeScopes, ['logo']);
    assert.equal(saved.request, 'Rustidian', 'the request box keeps the brand');
    assert.match(saved.mother.brief, /Rustidian/);
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const open = f.canvas.getByRole('button', { name: 'Open 1.svg', exact: true });
    await open.waitFor();
    const sent = f.runs[0].tasks;
    assert.deepEqual(sent.map(t => [t.id, t.kind, t.model, t.reasoningEffort, t.serviceTier]), [[logo.id, 'implement', 'gpt-6.1-sol', 'medium', 'priority']], 'one task on Sol, medium, Fast, and no check');
    assert.equal(f.plans.length, 0, 'nothing was planned');
    await open.click();
    assert.deepEqual(await f.page.evaluate(() => window.__opened), ['/tmp/demo/logo/1.svg']);
    await chooseOption(pattern, 'more');
    await f.canvas.getByRole('region', { name: 'Ready-made workflows' }).getByRole('button', { name: /^Logo/ }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Logo names the project when the request box is empty', async () => {
  const f = await openCanvas({ desktop: true, files: { '.': [] }, extraModels: [OPUS] });
  try {
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'logo');
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.result === 'logo/1.svg');
    const saved = await f.saved();
    assert.match(saved.mother.brief, /\bdemo\b/);
    assert.match(saved.nodes.find(n => n.type === 'agent').data.instruction, /\bdemo\b/);
  } finally { await f.close(); }
});

test('Logo says so when no model has the image generation tool, and leaves the board alone', async () => {
  const f = await openCanvas({ desktop: true, files: { '.': [] }, models: [OPUS] });
  try {
    await f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true }).fill('Rustidian');
    const before = await f.saved();
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'logo');
    await f.canvas.getByText('Logo needs a ChatGPT model, whose agents have the image generation tool, and none is available here.').waitFor();
    assert.deepEqual((await f.saved()).nodes, before.nodes);
    assert.equal(f.runs.length + f.plans.length, 0);
  } finally { await f.close(); }
});
