// 28 Oct, Masih: "we should expand the workflows; the /logo workflow". Logo builds the logo skill's team in the open project,
// with no planner, for the brand in the request box (or else the project's name): a Designer on the ChatGPT route, whose
// agents have the image generation tool, then a Curator, a Tracer through SVG Studio's CLI wrapper, and a Critic.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

const OPUS = { id: 'opus', model: 'claude/opus', displayName: 'Opus 5.5' };
const TRACE = 'SVG_STUDIO_MODULE=/home/masih/Desktop/p/svg/mcp-server/dist/vectorize.js node /home/masih/Desktop/p/skills/logo/scripts/trace.mjs';

test('Logo builds Designer, Curator, Tracer and Critic in order for the brand in the request box, and runs with no planner', async () => {
  const f = await openCanvas({ desktop: true, files: { '.': ['README.md'] }, extraModels: [OPUS] });
  try {
    await f.page.evaluate(() => { window.__opened = []; window.elpisDesktop.openFile = async target => { window.__opened.push(target); }; });
    await f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true }).fill('Rustidian');
    const pattern = f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true });
    await pattern.click();
    assert.deepEqual((await f.page.getByRole('option').allInnerTexts()).slice(0, 3).map(text => text.trim()), ['Transcribe images', 'Translate', 'Logo'], 'the ready-made workflows are on top');
    await f.page.keyboard.press('Escape');
    await chooseOption(pattern, 'logo');
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.result === 'logo/logo.svg');
    const saved = await f.saved(), agents = saved.nodes.filter(n => n.type === 'agent'), title = a => a.data.title.split(' · ')[1];
    assert.deepEqual(agents.map(title), ['Designer', 'Curator', 'Tracer', 'Critic']);
    const [designer, curator, tracer, critic] = agents;
    assert.deepEqual([designer.data.model, designer.data.provider ?? null], ['gpt-6.1-sol', null], 'the ChatGPT route, whose agents have the image generation tool');
    assert.match(designer.data.instruction, /Rustidian/);
    assert.match(designer.data.instruction, /image generation tool/);
    assert.ok(['logo/candidates/1.png', '2.png', '3.png', 'logo/candidates/prompts.md'].every(name => designer.data.instruction.includes(name)), 'three numbered directions with their exact prompts');
    // 28 Oct, the first live run: a check read the session logs for seven minutes; it judges the named files only.
    assert.match(designer.data.check, /open only the files named here: no logs/); assert.match(designer.data.instruction, /redraw one at most once/);
    assert.deepEqual(designer.data.writeScopes, ['logo/candidates']);
    assert.match(curator.data.instruction, /logo\/choice\.md/);
    assert.match(curator.data.instruction, /generic silhouettes/);
    assert.deepEqual(curator.data.writeScopes, ['logo']);
    assert.ok(tracer.data.instruction.includes(TRACE), 'the MCP servers are off, so the Tracer runs the skill\'s CLI wrapper');
    assert.match(tracer.data.instruction, /logo\/logo\.svg/);
    assert.match(tracer.data.instruction, /24, 32 and 64 px/);
    assert.deepEqual(tracer.data.writeScopes, ['logo']);
    assert.match(critic.data.instruction, /logo\/logo\.svg/);
    assert.match(critic.data.instruction, /fail/);
    assert.ok(critic.data.writeScopes[0].startsWith('agents/'), 'the Critic writes only its own folder');
    assert.deepEqual(saved.edges.map(e => `${e.source}>${e.target}`), [`${designer.id}>${curator.id}`, `${curator.id}>${tracer.id}`, `${tracer.id}>${critic.id}`], 'each step waits for the one before');
    assert.equal(saved.request, 'Rustidian', 'the request box keeps the brand');
    assert.match(saved.mother.brief, /Rustidian/);
    assert.equal(saved.mother.model, 'claude/opus');
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const open = f.canvas.getByRole('button', { name: 'Open logo.svg', exact: true });
    await open.waitFor();
    const sent = f.runs[0].tasks, implement = sent.filter(t => t.kind === 'implement');
    assert.deepEqual(implement.map(t => t.id), agents.map(a => a.id));
    assert.deepEqual(implement.slice(1).map(t => t.dependsOn), [designer, curator, tracer].map(a => [a.id, `${a.id}-check`]), 'each step waits for the one before and its check');
    assert.ok(implement[2].instruction.includes(TRACE));
    assert.equal(f.plans.length, 0, 'nothing was planned');
    await open.click();
    assert.deepEqual(await f.page.evaluate(() => window.__opened), ['/tmp/demo/logo/logo.svg']);
    await chooseOption(pattern, 'more');
    await f.canvas.getByRole('region', { name: 'Ready-made workflows' }).getByRole('button', { name: /^Logo/ }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Logo names the project when the request box is empty', async () => {
  const f = await openCanvas({ desktop: true, files: { '.': [] }, extraModels: [OPUS] });
  try {
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'logo');
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.result === 'logo/logo.svg');
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
