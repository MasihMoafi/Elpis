// Edits in the chat as Claude's desktop app shows them: an edit row ("Edited" + the file + "+3 −1") that opens to the same
// coloured, numbered diff as the Changes tab; the +N −M on the group's row; a "Changes · N files · View changes" footer
// per finished turn; and every kind of step (command, tool, search, edit) drawn as one kind of row. Local fixture of the
// bridge (tests/parity-fixture.cts): no engine, no model, no Git.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cts');

const PARSER = `${CWD}/src/lib/parser.ts`;
const PARSER_DIFF = "@@ -1,3 +1,5 @@\n import { lex } from './lexer';\n-export const parse = 1;\n+export function parse(src) {\n+  return lex(src);\n+}\n export default parse;\n";
const change = (path: string, kind: string, diff: string) => ({ path, kind: { type: kind }, diff });
const edit = (id: string, ...changes: ReturnType<typeof change>[]) => ({ id, type: 'fileChange', status: 'completed', changes });
const command = (id: string, extra = {}) => ({ id, type: 'commandExecution', command: `npm run ${id}`, cwd: CWD, status: 'completed', exitCode: 0, aggregatedOutput: 'ok', durationMs: 900, commandActions: [{ type: 'unknown', command: `npm run ${id}` }], ...extra });
const CHAT = [
  ['t1', 'Fix the parser.', 'Parser fixed.', [edit('f1', change(PARSER, 'update', PARSER_DIFF))]],
  ['t2', 'Tidy the notes.', 'Notes tidied.', [edit('f2', change(PARSER, 'update', '@@ -4 +4 @@\n-a\n+b\n'), change(`${CWD}/notes/new.md`, 'add', 'one\ntwo\n'), change(`${CWD}/notes/old.md`, 'delete', 'bye\n'))]],
  ['t3', 'Look things up.', 'Looked up.', [
    command('c1', { command: 'ls notes', description: undefined, durationMs: 30, commandActions: [{ type: 'unknown', command: 'ls notes' }] }),
    command('c2', { command: 'npm test', durationMs: 800, commandActions: [{ type: 'unknown', command: 'npm test' }] }),
    { id: 'm1', type: 'mcpToolCall', server: 'rag', tool: 'search', status: 'completed', durationMs: 1400, arguments: { query: 'parser' }, result: { content: [{ type: 'text', text: '2 hits' }] } },
    { id: 'w1', type: 'webSearch', query: 'two-pass parser design', results: [{ url: 'https://example.invalid/a', title: 'Parsers, in two passes', snippet: ' A short note.' }] },
    edit('f3', change(`${CWD}/src/app.ts`, 'update', '@@ -1 +1 @@\n-a\n+b\n'))]],
  ['t4', 'Say hello.', 'Hello.', []],
];
const GIT = {
  '/api/threads/chat-a/git': (_: unknown, url: URL) => url.searchParams.get('view') === 'changes'
    ? { root: CWD, files: [{ path: 'src/lib/parser.ts', status: 'modified', added: 3, removed: 1, binary: false }], truncated: false }
    : { diff: `diff --git a/src/lib/parser.ts b/src/lib/parser.ts\n--- a/src/lib/parser.ts\n+++ b/src/lib/parser.ts\n${PARSER_DIFF}`, truncated: false, binary: false },
};

type Locator = { count(): Promise<number>; nth(index: number): Locator; locator(selector: string): Locator; innerText(): Promise<string>; allInnerTexts(): Promise<string[]>; getByRole(role: string, options: { name: string | RegExp }): Locator; click(): Promise<void>; waitFor(): Promise<void>; evaluateAll(fn: (steps: Element[]) => (string | null | undefined)[]): Promise<(string | null | undefined)[]> };
type Page = { locator(selector: string): Locator; getByRole(role: string, options: { name: string }): Locator };
async function using(run: (f: { page: Page }) => Promise<void>, options = {}) {
  const f = await fixture({ chat: CHAT, height: 900, width: 1280, routes: GIT, ...options });
  try {
    await f.page.evaluate(() => { (window as Window & { __rgb?: (value: string) => string }).__rgb = (value: string) => { const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d'); if (!context) throw Error('Canvas context unavailable'); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const [r, g, b] = context.getImageData(0, 0, 1, 1).data; return `rgb(${r}, ${g}, ${b})`; }; });
    await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}

test('a finished turn ends with "Changes · N files · +N −M" and View changes opens the Changes tab', () => using(async ({ page }) => {
  const footers = page.locator('.turn-changes');
  assert.equal(await footers.count(), 3, 'one per turn that edited a file; none for the turn that did not');
  const text = async (index: number) => (await footers.nth(index).locator('.turn-changes-head').innerText()).replace(/\s+/g, ' ').trim();
  assert.equal(await text(0), 'Changes 1 file +3 −1 View changes');
  assert.equal(await text(1), 'Changes 3 files +3 −2 View changes');
  assert.equal(await page.locator('.turn').nth(3).locator('.turn-changes').count(), 0);
  // It opens to a row per file, each opening to its diff.
  const second = footers.nth(1);
  assert.equal(await second.locator('.step').count(), 0, 'closed: no rows');
  await second.getByRole('button', { name: /^Changes/ }).click();
  assert.deepEqual(await second.locator('.step').evaluateAll(steps => steps.map(step => step.querySelector('.step-file')?.textContent)), ['parser.ts', 'new.md', 'old.md']);
  assert.equal(await second.locator('.step-verb').count(), 0, 'the footer lists files; the verbs are in the rows above');
  await second.locator('.step-head').nth(1).click(); await second.locator('.step-card').waitFor();
  assert.deepEqual(await second.locator('.step-card .diff-line.add .diff-text').allInnerTexts(), ['one', 'two']);
  // View changes shows the Changes tab beside the chat.
  assert.equal(await page.getByRole('region', { name: 'Side panel' }).count(), 0);
  await footers.nth(0).getByRole('button', { name: 'View changes' }).click();
  const side = page.getByRole('region', { name: 'Side panel' });
  await side.locator('.changes').waitFor();
  await side.getByRole('list', { name: 'Changed files' }).waitFor();
  assert.match(await side.locator('.changes-summary').innerText(), /1 file changed/);
}));
