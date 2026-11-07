type TestWindow = typeof window & { __chosen: string[]; __opened: string[]; __asked: number };
// 28 Oct, Masih: "One workflow we need, for instance, is OCR via an agent ... a mother agent of either argon, opus, sonnet,
// sol ... and subagents of gemini-3.8", started seamlessly. Transcribe images builds that team from the folder named in the
// request, with no planner: Gemini 3.8 Flash readers a page each, by vision, side by side, and Elpis joining them in page order.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

// As the engine lists them: the subscriptions' models in its own list, routed by prefix (bridge/workflow-models.mjs).
const MODELS = { extraModels: [{ id: 'opus', model: 'claude/opus', displayName: 'Opus 5.5' }, { id: 'argon', model: 'agy/gemini-4-argon-high', displayName: 'Gemini 4 Argon' }, { id: 'g38', model: 'agy/gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' }, { id: 'g38l', model: 'agy/gemini-3.8-flash-low', displayName: 'Gemini 3.8 Flash (Low)' }] };
const pages = [...Array.from({ length: 8 }, (_, i) => `screen-${i + 1}.png`), 'screen-10.png', 'notes.txt'];

// 28 Oct, Masih: "it says Name the folder of page images in the request ... and no where I can do that! ... make it so I
// can choose that folder properly; and view the writings ... move it on top; and it should be one of the built-in workflows."
test('Transcribe images comes first, asks for its folder, keeps all it writes there, runs without planning and opens the result', async () => {
  const f = await openCanvas({ desktop: true, files: { '/tmp/books/sample|.': ['page-2.png', 'page-1.png', 'notes.txt'] }, ...MODELS });
  try {
    await f.page.evaluate(() => { (window as TestWindow).__chosen = []; (window as TestWindow).__opened = [];
      if (!window.elpisDesktop) throw new Error('Desktop bridge missing'); window.elpisDesktop.chooseFolder = async () => (window as TestWindow).__chosen.shift() ?? null;
      window.elpisDesktop.openFile = async target => { (window as TestWindow).__opened.push(target); }; });
    const pattern = f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true });
    await pattern.click();
    assert.equal((await f.page.getByRole('option').first().innerText()).trim(), 'Transcribe images', 'the ready-made workflow is on top');
    const tall = await f.page.getByRole('option').evaluateAll((options: Element[]) => options.map(option => option.firstElementChild ?? option)
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
    await f.page.evaluate(() => (window as TestWindow).__chosen.push('/tmp/books/sample'));
    await choose.click();
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1') ?? 'null')?.result === 'transcription.md');
    const saved = await f.saved(), agents = saved.nodes.filter((n: { type: string }) => n.type === 'agent');
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
    const joinTask = f.runs[0].tasks.find((task: { kind: string }) => task.kind === 'join');
    assert.deepEqual([joinTask.output, joinTask.flow, joinTask.parts.length], ['transcription.md', true, 2], 'Elpis joins the two pages');
    assert.equal(f.runs[0].tasks.some((task: { id: string }) => task.id === `${joinTask.id}-check`), false, 'a join has no check');
    await open.click();
    assert.deepEqual(await f.page.evaluate(() => (window as TestWindow).__opened), ['/tmp/books/sample/transcription.md']);
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
    await f.page.evaluate(() => { (window as TestWindow).__asked = 0; if (!window.elpisDesktop) throw new Error('Desktop bridge missing'); window.elpisDesktop.chooseFolder = async () => { (window as TestWindow).__asked++; return null; }; });
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'transcribe');
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1') ?? 'null')?.result === 'transcription.md');
    const saved = await f.saved();
    assert.equal(await f.page.evaluate(() => (window as TestWindow).__asked), 0, 'no dialog');
    assert.match(saved.nodes.find((n: { type: string }) => n.type === 'agent').data.instruction, /\n- page-1\.png\n/);
    assert.equal(saved.request, 'Transcribe the page images in demo into transcription.md');
    await f.canvas.getByRole('button', { name: 'Choose folder', exact: true }).click();
    assert.equal(await f.page.evaluate(() => (window as TestWindow).__asked), 1, 'Choose folder still asks');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct, Masih's screenshots: with a finished run's status and its Open button in the row, the request box shrank to
// "Cr…" and "Tra", and its label stood one word per line. At 1100 px the box keeps a usable width and its label one line.
// 28 Oct, the first live Logo run: in a git repository each agent got its own worktree, and the Designer's candidates
// never reached the project. A ready-made team runs in the project itself; a drawn team still asks for worktrees.
test('a ready-made team in a git repository runs in the project itself, with no worktrees', async () => {
  const f = await openCanvas({ desktop: true, repository: true, files: { '/tmp/demo|.': ['page-1.png', 'page-2.png'] }, ...MODELS });
  try {
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'transcribe');
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1') ?? 'null')?.result === 'transcription.md');
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.canvas.getByRole('button', { name: 'Open transcription.md', exact: true }).waitFor();
    assert.equal('isolation' in f.runs[0], false, 'no worktrees');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
