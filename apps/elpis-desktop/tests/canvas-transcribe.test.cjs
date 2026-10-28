// 28 Oct, Masih: "One workflow we need, for instance, is OCR via an agent ... a mother agent of either argon, opus, sonnet,
// sol ... and subagents of gemini-3.8", started seamlessly. Transcribe images builds that team from the folder named in the
// request, with no planner: Gemini 3.8 Flash readers a page each, by vision, side by side, and Elpis joining them in page order.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { captureReview, chooseOption } = require('./controls.cjs');

// As the engine lists them: the subscriptions' models in its own list, routed by prefix (bridge/workflow-models.mjs).
const MODELS = { extraModels: [{ id: 'opus', model: 'claude/opus', displayName: 'Opus 5.5' }, { id: 'argon', model: 'agy/gemini-4-argon-high', displayName: 'Gemini 4 Argon' }, { id: 'g38', model: 'agy/gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' }, { id: 'g38l', model: 'agy/gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)' }] };
const pages = [...Array.from({ length: 8 }, (_, i) => `screen-${i + 1}.png`), 'screen-10.png', 'notes.txt'];

test('Transcribe images builds one Gemini reader a page, side by side, and a join by Elpis, with Mother on the strongest model', async () => {
  const f = await openCanvas({ folders: ['docs', 'book/pages'], files: { 'book/pages': pages, docs: ['readme.md'] }, ...MODELS });
  try {
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'transcribe');
    const request = f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    await request.fill('Transcribe the screenshots in book/pages into one clean Markdown file');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.nodes ?? []).filter(n => n.type === 'agent').length === 9);
    const saved = await f.saved(), agents = saved.nodes.filter(n => n.type === 'agent');
    // 28 Oct, Masih: "Why is it taking so excruciatingly long?" A reader a page, side by side (at most eight), on Flash at low
    // effort, and Elpis joins them itself: no join agent, no join check.
    assert.deepEqual(agents.map(a => a.data.title.split(' · ')[1]), ['Page 1', 'Page 2', 'Page 3', 'Pages 4–5', 'Page 6', 'Page 7', 'Page 8', 'Page 9', 'Join the pages']);
    const readers = agents.slice(0, -1), join = agents.at(-1);
    assert.ok(readers.every(a => a.data.model === 'agy/gemini-3.8-flash-low' && !a.data.provider), JSON.stringify(readers.map(a => [a.data.model, a.data.provider])));
    assert.match(agents[3].data.instruction, /book\/pages\/screen-4\.png\n- book\/pages\/screen-5\.png/, 'shared pages stay in order');
    assert.match(agents[7].data.instruction, /book\/pages\/screen-10\.png/, 'pages in natural order');
    assert.deepEqual(join.data.join, { parts: readers.map(a => `${a.data.writeScopes[0]}/pages.md`), output: 'book/pages/transcription.md', flow: true });
    assert.match(agents[0].data.instruction, /own vision\. Do not run OCR/);
    assert.equal(agents.some(a => a.data.instruction.includes('notes.txt')), false, 'only images are pages');
    assert.deepEqual(join.data.writeScopes, ['book/pages']);
    assert.match(join.data.instruction, /into book\/pages\/transcription\.md/);
    assert.deepEqual([saved.mother.model, saved.mother.provider], ['claude/opus', null], 'Mother takes the strongest model available');
    assert.equal(f.plans.length, 0, 'the team is built, not planned');
    // The cards and Mother's menu name the subscriptions' models, not their ids.
    assert.match(await f.canvas.locator('.react-flow__node').filter({ has: f.page.locator('.agent-node-title', { hasText: /· Page 1$/ }) }).innerText(), /Gemini 3\.8 Flash \(Low\)/);
    await f.canvas.locator('.react-flow__node').filter({ hasText: 'MOTHER' }).first().click();
    assert.equal((await f.canvas.getByRole('combobox', { name: 'Her model', exact: true }).innerText()).trim(), 'Opus 5.5');
    // A reader's own panel names its subscription and model (28 Oct: it said OpenAI and agy/gemini-3.8-flash-high), and
    // picking another subscription keeps the route in the model, with no provider.
    await f.canvas.locator('.react-flow__node').filter({ has: f.page.locator('.agent-node-title', { hasText: /· Page 1$/ }) }).click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    const provider = panel.getByRole('combobox', { name: 'Provider', exact: true }), model = panel.getByRole('combobox', { name: 'Model', exact: true });
    assert.deepEqual([(await provider.innerText()).trim(), (await model.innerText()).trim()], ['Antigravity', 'Gemini 3.8 Flash (Low)']);
    await chooseOption(model, '|agy/gemini-4-argon-high');
    await chooseOption(provider, 'claude/');
    assert.equal((await model.innerText()).trim(), 'Opus 5.5');
    const reader = (await f.saved()).nodes.find(n => n.data.title?.endsWith('Page 1'));
    assert.deepEqual([reader.data.model, reader.data.provider], ['claude/opus', null]);
    // A folder without page images says so and leaves the board alone.
    await request.fill('Transcribe docs');
    await f.canvas.getByRole('button', { name: 'New workflow', exact: true }).click();
    await f.canvas.getByText('No page images (PNG, JPG or WebP) in docs.').waitFor();
    assert.equal((await f.saved()).nodes.filter(n => n.type === 'agent').length, 9);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct, Masih: "it says Name the folder of page images in the request ... and no where I can do that! ... make it so I
// can choose that folder properly; and view the writings ... move it on top; and it should be one of the built-in workflows."
test('Transcribe images comes first, asks for its folder, keeps all it writes there, runs without planning and opens the result', async () => {
  const f = await openCanvas({ desktop: true, files: { '/tmp/books/sample|.': ['page-2.png', 'page-1.png', 'notes.txt'] }, ...MODELS });
  try {
    await f.page.evaluate(() => { window.__chosen = []; window.__opened = [];
      window.elpisDesktop.chooseFolder = async () => window.__chosen.shift() ?? null;
      window.elpisDesktop.openFile = async target => { window.__opened.push(target); }; });
    const pattern = f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true });
    await pattern.click();
    assert.equal((await f.page.getByRole('option').first().innerText()).trim(), 'Transcribe images', 'the ready-made workflow is on top');
    const tall = await f.page.getByRole('option').evaluateAll(options => options.map(option => option.firstElementChild ?? option)
      .filter(label => label.getBoundingClientRect().height > 2.4 * parseFloat(getComputedStyle(label).fontSize)).map(label => label.textContent));
    assert.deepEqual(tall, [], 'every label keeps one line');
    await f.page.keyboard.press('Escape');
    // Cancelling the chooser changes nothing; a chosen folder outside the project becomes the project.
    // Text left in the request box from another workflow never becomes this one's goal (28 Oct).
    await f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true }).fill('Create a file named elpis-check.txt');
    const before = await f.saved();
    await chooseOption(pattern, 'transcribe');
    const choose = f.canvas.getByRole('button', { name: 'Choose folder', exact: true });
    await choose.waitFor();
    assert.deepEqual((await f.saved()).nodes, before.nodes, 'a cancelled chooser leaves the board alone');
    await f.page.evaluate(() => window.__chosen.push('/tmp/books/sample'));
    await choose.click();
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.result === 'transcription.md');
    const saved = await f.saved(), agents = saved.nodes.filter(n => n.type === 'agent');
    assert.match(agents[0].data.instruction, /\n- page-1\.png\n/, 'a reader a page, by its name'); assert.match(agents[1].data.instruction, /\n- page-2\.png\n/);
    assert.ok(agents[0].data.writeScopes[0].startsWith('agents/'), 'a reader writes in its own folder');
    assert.deepEqual([agents[2].data.writeScopes, saved.result], [['.'], 'transcription.md']);
    assert.deepEqual([saved.request, saved.mother.brief], Array(2).fill('Transcribe the page images in sample into transcription.md'));
    await f.canvas.getByRole('button', { name: 'Choose project' }).filter({ hasText: 'sample' }).waitFor();
    // Run graph starts at once, with no planner, and the finished run opens what it wrote.
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const open = f.canvas.getByRole('button', { name: 'Open transcription.md', exact: true });
    await open.waitFor();
    // 28 Oct, Masih: "For two pages? It shouldn't take that long." The reader had wandered other books' folders for four
    // minutes and its check ran OCR and diffs: a reader opens only its pages, and its check compares them by sight.
    const [read, readCheck] = f.runs[0].tasks;
    assert.match(read.instruction, /Open no other file or folder/);
    assert.match(readCheck.instruction, /Look at each page image beside pages\.md[\s\S]*Run no scripts or OCR/);
    assert.doesNotMatch(readCheck.instruction, /the build, the tests/);
    const joinTask = f.runs[0].tasks.find(task => task.kind === 'join');
    assert.deepEqual([joinTask.output, joinTask.flow, joinTask.parts.length], ['transcription.md', true, 2], 'Elpis joins the two pages');
    assert.equal(f.runs[0].tasks.some(task => task.id === `${joinTask.id}-check`), false, 'a join has no check');
    await open.click();
    assert.deepEqual(await f.page.evaluate(() => window.__opened), ['/tmp/books/sample/transcription.md']);
    assert.equal(f.plans.length, 0, 'nothing was planned');
    // It is one of the ready-made workflows in the library too.
    await chooseOption(pattern, 'more');
    await f.canvas.getByRole('region', { name: 'Ready-made workflows' }).getByRole('button', { name: /^Transcribe images/ }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct: from his own window the run could not start without the system's folder dialog, though the project open was the
// folder of pages. A ready-made workflow picked while the project already holds what it works on uses that folder at once;
// "Choose folder" picks another. (A project without them asks for the folder: the test above.)
test('Transcribe images picked in a folder of pages builds its team there at once, with no folder dialog', async () => {
  const f = await openCanvas({ desktop: true, files: { '/tmp/demo|.': ['page-1.png', 'page-2.png'] }, ...MODELS });
  try {
    await f.page.evaluate(() => { window.__asked = 0; window.elpisDesktop.chooseFolder = async () => { window.__asked++; return null; }; });
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'transcribe');
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.result === 'transcription.md');
    const saved = await f.saved();
    assert.equal(await f.page.evaluate(() => window.__asked), 0, 'no dialog');
    assert.match(saved.nodes.find(n => n.type === 'agent').data.instruction, /\n- page-1\.png\n/);
    assert.equal(saved.request, 'Transcribe the page images in demo into transcription.md');
    await f.canvas.getByRole('button', { name: 'Choose folder', exact: true }).click();
    assert.equal(await f.page.evaluate(() => window.__asked), 1, 'Choose folder still asks');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct, Masih's screenshots: with a finished run's status and its Open button in the row, the request box shrank to
// "Cr…" and "Tra", and its label stood one word per line. At 1100 px the box keeps a usable width and its label one line.
test('the request box keeps its width and its label one line beside a finished run at 1100 px', async () => {
  const f = await openCanvas({ desktop: true, width: 1100, files: { '/tmp/demo|.': ['page-1.png', 'page-2.png'] }, ...MODELS });
  try {
    await f.page.evaluate(() => { window.elpisDesktop.openFile = async () => {}; });
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'transcribe');
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.result === 'transcription.md');
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.canvas.getByRole('button', { name: 'Open transcription.md', exact: true }).waitFor();
    const box = await f.canvas.getByRole('textbox', { name: 'Workflow request', exact: true }).boundingBox();
    assert.ok(box.width >= 240, `request box ${Math.round(box.width)} px wide`);
    const label = await f.canvas.locator('label', { hasText: 'What should the workflow do?' }).evaluate(el => { const r = document.createRange(); r.selectNodeContents(el.firstChild); return r.getClientRects().length; });
    assert.equal(label, 1, 'the label is one line');
    await captureReview(f.page, 'workflow-toolbar-1100');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
