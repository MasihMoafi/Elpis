// 28 Oct, Masih: the ready-made workflows go one at a time, "OCR first", then translation with farsi-translator's method:
// English into conversational Farsi through the Gemini login. Translate to Farsi builds that team from the chosen folder,
// with no planner: one agent writes a glossary of names and terms, Gemini translators take about 1,500 words each, one joins them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

const MODELS = { extraModels: [{ id: 'opus', model: 'claude/opus', displayName: 'Opus 5.5' }, { id: 'g38', model: 'agy/gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' }, { id: 'g38m', model: 'agy/gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)' }] };
const words = (n, word) => Array.from({ length: n }, () => word).join(' ');
// Three 1,000-word paragraphs: the first two make one part (lines 1–3), the third another (line 5).
const english = [words(1000, 'one'), words(1000, 'two'), words(1000, 'three')].join('\n\n') + '\n';

test('Translate to Farsi asks for its folder, writes a glossary first, translates in parts and joins them into translation.md', async () => {
  const f = await openCanvas({ desktop: true, files: { '/tmp/books/sample|.': ['page-1.png', 'notes.txt', 'transcription.md', 'translation.md'] }, texts: { 'transcription.md': english, 'notes.txt': 'not this' }, ...MODELS });
  try {
    await f.page.evaluate(() => { window.__chosen = []; window.__opened = [];
      window.elpisDesktop.chooseFolder = async () => window.__chosen.shift() ?? null;
      window.elpisDesktop.openFile = async target => { window.__opened.push(target); }; });
    const pattern = f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true });
    await pattern.click();
    assert.deepEqual((await f.page.getByRole('option').allInnerTexts()).slice(0, 2).map(text => text.trim()), ['Transcribe images', 'Translate to Farsi'], 'the ready-made workflows are on top');
    await f.page.keyboard.press('Escape');
    await chooseOption(pattern, 'translate');
    await f.page.evaluate(() => window.__chosen.push('/tmp/books/sample'));
    await f.canvas.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await f.page.waitForFunction(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))?.result === 'translation.md');
    const saved = await f.saved(), agents = saved.nodes.filter(n => n.type === 'agent'), title = a => a.data.title.split(' · ')[1];
    assert.deepEqual(agents.map(title), ['Glossary', 'Lines 1–3', 'Line 5', 'Join the parts']);
    assert.ok(agents.every(a => a.data.model === 'agy/gemini-3.8-flash-medium' && !a.data.provider), 'the Gemini login, as in the accepted pilot');
    const [terms, first, second, join] = agents, glossary = `${terms.data.writeScopes[0]}/glossary.md`;
    assert.ok(terms.data.writeScopes[0].startsWith('agents/') && /glossary\.md/.test(terms.data.instruction));
    assert.match(first.data.instruction, /lines 1–3 of transcription\.md/);
    assert.match(second.data.instruction, /line 5 of transcription\.md/);
    assert.ok([first, second].every(a => a.data.instruction.includes(glossary) && a.data.instruction.includes('«میرم»') && a.data.writeScopes[0].startsWith('agents/')), 'each part follows the agreed terms and the spoken style');
    assert.equal(agents.some(a => a.data.instruction.includes('notes.txt')), false, 'a transcription is the text to translate');
    assert.deepEqual(join.data.writeScopes, ['.']);
    assert.match(join.data.instruction, /into translation\.md/);
    const edges = saved.edges.map(e => `${e.source}>${e.target}`).sort();
    assert.deepEqual(edges, [`${terms.id}>${first.id}`, `${terms.id}>${second.id}`, `${first.id}>${join.id}`, `${second.id}>${join.id}`].sort());
    assert.deepEqual([saved.request, saved.mother.brief, saved.mother.model], [...Array(2).fill('Translate the English in sample into Farsi in translation.md'), 'claude/opus']);
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const open = f.canvas.getByRole('button', { name: 'Open translation.md', exact: true });
    await open.waitFor();
    // A translator reads only its lines and the glossary, and its check reads the Farsi beside the English.
    const part = f.runs[0].tasks.find(t => t.id === first.id), partCheck = f.runs[0].tasks.find(t => t.id !== first.id && t.dependsOn?.includes(first.id) && t.kind === 'verify');
    assert.match(part.instruction, /Open no other file or folder/);
    assert.match(partCheck.instruction, /Read part\.md beside lines 1–3 of transcription\.md[\s\S]*Run no scripts/);
    await open.click();
    assert.deepEqual(await f.page.evaluate(() => window.__opened), ['/tmp/books/sample/translation.md']);
    assert.equal(f.plans.length, 0, 'nothing was planned');
    await chooseOption(pattern, 'more');
    await f.canvas.getByRole('region', { name: 'Ready-made workflows' }).getByRole('button', { name: /^Translate to Farsi/ }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Translate to Farsi says so when the folder has no English text, and leaves the board alone', async () => {
  const f = await openCanvas({ desktop: true, files: { '.': ['page-1.png'] }, ...MODELS });
  try {
    await f.page.evaluate(() => { window.elpisDesktop.chooseFolder = async () => '/tmp/books/pages'; });
    const before = await f.saved();
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'translate');
    await f.canvas.getByText('No English text (Markdown or plain text) in pages.').waitFor();
    assert.deepEqual((await f.saved()).nodes, before.nodes);
  } finally { await f.close(); }
});
