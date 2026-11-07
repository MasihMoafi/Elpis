// 28 Oct, Masih: the ready-made workflows go one at a time, "OCR first", then translation with farsi-translator's method:
// English into conversational Farsi through the Gemini login. Translate to Farsi builds that team from the chosen folder,
// with no planner: one agent writes a glossary of names and terms, Gemini translators take about 1,500 words each, one joins them.
import type { CanvasGraph, CanvasNode, RunTask } from '../lib/canvas.ts';

const test: typeof import('node:test').test = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
type Agent = Extract<CanvasNode, { type: 'agent' }>;
type DraftState = Pick<CanvasGraph, 'result' | 'language' | 'request'>;
type Locator = {
  getByRole(role: string, options?: object): Locator;
  getByText(text: string, options?: object): Locator;
  nth(index: number): Locator;
  allInnerTexts(): Promise<string[]>;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  waitFor(): Promise<void>;
};
type Page = {
  getByRole(role: string, options?: object): Locator;
  keyboard: { press(key: string): Promise<void> };
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  waitForFunction(fn: () => boolean): Promise<void>;
};
type Fixture = { page: Page; canvas: Locator; runs: { tasks: RunTask[] }[]; plans: unknown[]; errors: unknown[]; saved(): Promise<CanvasGraph>; close(): Promise<void> };
type TestWindow = typeof window & { __chosen: string[]; __opened: string[] };
const { openCanvas }: { openCanvas(options: object): Promise<Fixture> } = require('./canvas-fixture.cts');
const { chooseOption }: { chooseOption(locator: Locator, value: string): Promise<void> } = require('./controls.cts');

const MODELS = { extraModels: [{ id: 'opus', model: 'claude/opus', displayName: 'Opus 5.5' }, { id: 'g38', model: 'agy/gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' }, { id: 'g38m', model: 'agy/gemini-3.8-flash-medium', displayName: 'Gemini 3.8 Flash (Medium)' }] };
const words = (n: number, word: string) => Array.from({ length: n }, () => word).join(' ');
const scopeOf = (agent: Agent) => { const scope = agent.data.writeScopes[0]; assert.ok(scope); return scope; };
// Three 1,000-word paragraphs: the first two make one part (lines 1–3), the third another (line 5).
const english = [words(1000, 'one'), words(1000, 'two'), words(1000, 'three')].join('\n\n') + '\n';

test('Translate to Farsi asks for its folder, writes a glossary first, translates in parts and joins them into translation.md', async () => {
  const f = await openCanvas({ desktop: true, files: { '/tmp/books/sample|.': ['page-1.png', 'notes.txt', 'transcription.md', 'translation.md'] }, texts: { 'transcription.md': english, 'notes.txt': 'not this' }, ...MODELS });
  try {
    await f.page.evaluate(() => { const target = window as TestWindow, desktop = window.elpisDesktop; target.__chosen = []; target.__opened = [];
      if (!desktop) throw Error('Desktop unavailable');
      desktop.chooseFolder = async () => target.__chosen.shift() ?? null;
      desktop.openFile = async file => { target.__opened.push(file); }; });
    const pattern = f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true });
    await pattern.click();
    await f.page.getByRole('option').nth(1).waitFor();
    assert.deepEqual((await f.page.getByRole('option').allInnerTexts()).slice(0, 2).map(text => text.trim()), ['Transcribe images', 'Translate'], 'the ready-made workflows are on top');
    await f.page.keyboard.press('Escape');
    await chooseOption(pattern, 'translate');
    await f.page.evaluate(() => (window as TestWindow).__chosen.push('/tmp/books/sample'));
    await f.canvas.getByRole('button', { name: 'Choose folder', exact: true }).click();
    await f.page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-workflow-draft-v1') ?? 'null') as DraftState | null)?.result === 'translation.md');
    const saved = await f.saved(), agents = saved.nodes.filter((n): n is Agent => n.type === 'agent'), title = (a: Agent) => a.data.title.split(' · ')[1];
    assert.deepEqual(agents.map(title), ['Glossary', 'Lines 1–3', 'Line 5', 'Join the parts']);
    assert.ok(agents.slice(0, -1).every(a => a.data.model === 'agy/gemini-3.8-flash-medium' && !a.data.provider), 'the Gemini login, as in the accepted pilot');
    const last = agents.at(-1); assert.ok(last);
    assert.equal(last.data.join?.output, 'translation.md', 'Elpis joins the parts itself');
    const [terms, first, second, join] = agents; assert.ok(terms && first && second && join);
    const glossary = `${scopeOf(terms)}/glossary.md`;
    assert.ok(scopeOf(terms).startsWith('agents/') && /glossary\.md/.test(terms.data.instruction));
    assert.match(first.data.instruction, /lines 1–3 of transcription\.md/);
    assert.match(second.data.instruction, /line 5 of transcription\.md/);
    assert.ok([first, second].every(a => a.data.instruction.includes(glossary) && a.data.instruction.includes('«میرم»') && scopeOf(a).startsWith('agents/')), 'each part follows the agreed terms and the spoken style');
    assert.equal(agents.some(a => a.data.instruction.includes('notes.txt')), false, 'a transcription is the text to translate');
    assert.deepEqual(join.data.writeScopes, ['.']);
    assert.match(join.data.instruction, /into translation\.md/);
    const edges = saved.edges.map(e => `${e.source}>${e.target}`).sort();
    assert.deepEqual(edges, [`${terms.id}>${first.id}`, `${terms.id}>${second.id}`, `${first.id}>${join.id}`, `${second.id}>${join.id}`].sort());
    assert.ok(saved.mother);
    assert.deepEqual([saved.request, saved.mother.brief, saved.mother.model], [...Array(2).fill('Translate the English in sample into Farsi in translation.md'), 'claude/opus']);
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const open = f.canvas.getByRole('button', { name: 'Open translation.md', exact: true });
    await open.waitFor();
    // A translator reads only its lines and the glossary, and its check reads the Farsi beside the English.
    const run = f.runs[0]; assert.ok(run);
    const part = run.tasks.find(t => t.id === first.id), partCheck = run.tasks.find(t => t.id !== first.id && t.dependsOn?.includes(first.id) && t.kind === 'verify');
    assert.ok(part && partCheck);
    assert.match(part.instruction, /Open no other file or folder/);
    assert.match(partCheck.instruction, /Read part\.md beside lines 1–3 of transcription\.md[\s\S]*Run no scripts/);
    await open.click();
    assert.deepEqual(await f.page.evaluate(() => (window as TestWindow).__opened), ['/tmp/books/sample/translation.md']);
    assert.equal(f.plans.length, 0, 'nothing was planned');
    await chooseOption(pattern, 'more');
    await f.canvas.getByRole('region', { name: 'Ready-made workflows' }).getByRole('button', { name: /^Translate/ }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Translate to Farsi says so when the folder has no English text, and leaves the board alone', async () => {
  const f = await openCanvas({ desktop: true, files: { '.': ['page-1.png'] }, ...MODELS });
  try {
    await f.page.evaluate(() => { const desktop = window.elpisDesktop; if (!desktop) throw Error('Desktop unavailable'); desktop.chooseFolder = async () => '/tmp/books/pages'; });
    const before = await f.saved();
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'translate');
    await f.canvas.getByText('No English text (Markdown or plain text) in pages.').waitFor();
    assert.deepEqual((await f.saved()).nodes, before.nodes);
  } finally { await f.close(); }
});

// 28 Oct, Masih: "not translate to Farsi exclusively; translate to anything", and "the agent would pick, if the user
// doesn't, the proper model from the OpenRouter". German, with no model chosen, goes to the OpenRouter model that writes
// it best among those offered, the notice names it, and every agent speaks German; Farsi keeps its own rules (above).
test('Translate to German picks the OpenRouter model that writes German best, names it, and writes German throughout', async () => {
  const openrouter = [{ id: 'q', model: 'qwen/qwen3-max', displayName: 'Qwen3 Max' }, { id: 's', model: 'anthropic/claude-sonnet-5', displayName: 'Claude Sonnet 5' }, { id: 'g', model: 'google/gemini-3-pro', displayName: 'Gemini 3 Pro' }];
  const f = await openCanvas({ desktop: true, files: { '/tmp/demo|.': ['transcription.md'] }, texts: { 'transcription.md': english }, ...MODELS,
    settings: { providers: [{ id: 'openai', displayName: 'OpenAI' }, { id: 'openrouter', displayName: 'OpenRouter' }] }, providerModels: { openrouter } });
  try {
    await chooseOption(f.canvas.getByRole('combobox', { name: 'Workflow pattern', exact: true }), 'translate');
    await f.page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-workflow-draft-v1') ?? 'null') as DraftState | null)?.result === 'translation.md');
    // Any language can be typed; a tuned one is matched by name (28 Oct: "translate to anything").
    const language = f.canvas.getByRole('combobox', { name: 'Language', exact: true });
    await language.fill('German'); await language.press('Enter');
    await f.page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-workflow-draft-v1') ?? 'null') as DraftState | null)?.language === 'de');
    const saved = await f.saved(), workers = saved.nodes.filter((n): n is Agent => n.type === 'agent' && !n.data.join);
    assert.ok(workers.every(a => a.data.model === 'anthropic/claude-sonnet-5' && a.data.provider === 'openrouter'), JSON.stringify(workers.map(a => [a.data.model, a.data.provider])));
    await f.canvas.getByText('The translators use Claude Sonnet 5 on OpenRouter, the best writer of German among your models.').waitFor();
    assert.equal(saved.request, 'Translate the English in demo into German in translation.md');
    const first = workers[0]; assert.ok(first);
    assert.match(first.data.instruction, /English → German/);
    assert.ok(workers.slice(1).every(a => /into German/.test(a.data.instruction) && !a.data.instruction.includes('«میرم»')), 'German rules, not Farsi ones');
    // A language that is not in the list is used as typed.
    await language.fill('swahili'); await language.press('Enter');
    await f.page.waitForFunction(() => (JSON.parse(localStorage.getItem('elpis-workflow-draft-v1') ?? 'null') as DraftState | null)?.language === 'swahili');
    await f.page.waitForFunction(() => /into Swahili/.test((JSON.parse(localStorage.getItem('elpis-workflow-draft-v1') ?? 'null') as DraftState | null)?.request ?? ''));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
