// Edits in the chat as Claude's desktop app shows them: an edit row ("Edited" + the file + "+3 −1") that opens to the same
// coloured, numbered diff as the Changes tab; the +N −M on the group's row; a "Changes · N files · View changes" footer
// per finished turn; and every kind of step (command, tool, search, edit) drawn as one kind of row. Local fixture of the
// bridge (tests/parity-fixture.cjs): no engine, no model, no Git.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');

const PARSER = `${CWD}/src/lib/parser.ts`;
const PARSER_DIFF = "@@ -1,3 +1,5 @@\n import { lex } from './lexer';\n-export const parse = 1;\n+export function parse(src) {\n+  return lex(src);\n+}\n export default parse;\n";
const change = (path, kind, diff) => ({ path, kind: { type: kind }, diff });
const edit = (id, ...changes) => ({ id, type: 'fileChange', status: 'completed', changes });
const command = (id, extra = {}) => ({ id, type: 'commandExecution', command: `npm run ${id}`, cwd: CWD, status: 'completed', exitCode: 0, aggregatedOutput: 'ok', durationMs: 900, commandActions: [{ type: 'unknown', command: `npm run ${id}` }], ...extra });
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
  '/api/threads/chat-a/git': (_, url) => url.searchParams.get('view') === 'changes'
    ? { root: CWD, files: [{ path: 'src/lib/parser.ts', status: 'modified', added: 3, removed: 1, binary: false }], truncated: false }
    : { diff: `diff --git a/src/lib/parser.ts b/src/lib/parser.ts\n--- a/src/lib/parser.ts\n+++ b/src/lib/parser.ts\n${PARSER_DIFF}`, truncated: false, binary: false },
};

async function using(run, options = {}) {
  const f = await fixture({ chat: CHAT, height: 900, width: 1280, routes: GIT, ...options });
  try {
    await f.page.evaluate(() => { window.__rgb = value => { const context = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d'); context.fillStyle = value; context.fillRect(0, 0, 1, 1); const [r, g, b] = context.getImageData(0, 0, 1, 1).data; return `rgb(${r}, ${g}, ${b})`; }; });
    await f.open('chat-a'); await run(f); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
}
const unfold = async page => { for (const fold of await page.locator('.worked-for > summary').all()) await fold.click(); };
const numbers = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
const channel = value => numbers(value).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const luminance = value => { const [r, g, b] = channel(value); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('a finished group says what it did with +N −M, and its edit row names the verb and a short path apart', () => using(async ({ page }) => {
  await unfold(page);
  const group = page.locator('.activity-group').filter({ hasText: /^Edited parser\.ts/ }).first();
  assert.match((await group.locator('> summary').innerText()).replace(/\s+/g, ' ').trim(), /^Edited parser\.ts \+3 −1$/, 'the group row ends with its counts');
  await group.locator('> summary').click();
  const row = group.locator('.step').first();
  assert.equal((await row.locator('.step-verb').innerText()).trim(), 'Edited');
  assert.equal((await row.locator('.step-file').innerText()).trim(), 'parser.ts');
  assert.equal((await row.locator('.step-hint').innerText()).trim(), '…/src/lib', 'the folders above it, shortened, never the whole absolute path');
  assert.equal((await row.locator('.change-counts .add').innerText()).trim(), '+3');
  assert.equal((await row.locator('.change-counts .del').innerText()).trim(), '−1');
  assert.doesNotMatch(await page.locator('.turn').first().innerText(), /update|tmp\/parity-fixture/, 'no "update" glued to a path, no absolute path in the row');
  assert.equal(await row.locator('.step-file').getAttribute('title'), PARSER, 'the whole path is the tooltip');
  // A created and a deleted file read as their own verbs, with their own counts.
  const second = page.locator('.turn').nth(1);
  await second.locator('.activity-group > summary').first().click();
  const verbs = await second.locator('.step').evaluateAll(steps => steps.map(step => [step.querySelector('.step-verb')?.textContent, step.querySelector('.step-file')?.textContent, step.querySelector('.change-counts')?.textContent.replace(/\s+/g, ' ').trim()]));
  assert.deepEqual(verbs, [['Edited', 'parser.ts', '+1 −1'], ['Created', 'new.md', '+2 −0'], ['Deleted', 'old.md', '+0 −1']]);
}));

test('clicking an edit row opens its diff: coloured, numbered, one component with the Changes tab; Enter and Space work too', () => using(async ({ page }) => {
  await unfold(page);
  const group = page.locator('.activity-group').filter({ hasText: /^Edited parser\.ts/ }).first();
  await group.locator('> summary').click();
  const head = group.locator('.step > .step-head').first(), card = group.locator('.step-card');
  assert.equal(await card.count(), 0, 'closed: no diff is drawn');
  await head.click(); await card.waitFor(); // the card is drawn when the details' toggle event arrives, a moment after the click
  assert.equal(await card.locator('.diff-line.add').count(), 3);
  assert.equal(await card.locator('.diff-line.del').count(), 1);
  assert.equal(await card.locator('.diff-line.hunk').count(), 1);
  assert.deepEqual(await card.locator('.diff-line.add .diff-no').allInnerTexts(), ['', '2', '', '3', '', '4'], 'new line numbers, with the old column empty');
  const tint = await card.locator('.diff-line.add').first().evaluate(node => window.__rgb(getComputedStyle(node).backgroundColor)), del = await card.locator('.diff-line.del').first().evaluate(node => window.__rgb(getComputedStyle(node).backgroundColor));
  const [ar, ag, ab] = numbers(tint), [dr, dg, db] = numbers(del);
  assert.ok(ag > ar && ag > ab, `added lines are green (${tint})`);
  assert.ok(dr > dg && dr > db, `removed lines are red (${del})`);
  // Enter and Space close and open it again.
  await head.focus(); await page.keyboard.press('Enter'); await card.waitFor({ state: 'detached' });
  await page.keyboard.press(' '); await card.waitFor();
  const inChat = await card.locator('.diff-line.add').first().evaluate(node => ({ html: node.outerHTML, style: [...['backgroundColor', 'fontFamily', 'fontSize', 'lineHeight']].map(key => getComputedStyle(node)[key]) }));
  // The Changes tab draws the same lines.
  const side = page.getByRole('region', { name: 'Side panel' });
  await page.getByRole('button', { name: 'Show side panel' }).click();
  await side.getByRole('button', { name: 'New side panel tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Changes', exact: true }).click();
  const panel = side.locator('.diff-view .diff-line.add').first(); await panel.waitFor();
  const inPanel = await panel.evaluate(node => ({ html: node.outerHTML, style: [...['backgroundColor', 'fontFamily', 'fontSize', 'lineHeight']].map(key => getComputedStyle(node)[key]) }));
  assert.deepEqual(inChat.style, inPanel.style, 'the same colours and type in the chat and in the Changes tab');
  assert.equal(inChat.html.replace(/>[^<]*/g, '>'), inPanel.html.replace(/>[^<]*/g, '>'), 'the same markup');
}));

test('a finished turn ends with "Changes · N files · +N −M" and View changes opens the Changes tab', () => using(async ({ page }) => {
  const footers = page.locator('.turn-changes');
  assert.equal(await footers.count(), 3, 'one per turn that edited a file; none for the turn that did not');
  const text = async index => (await footers.nth(index).locator('.turn-changes-head').innerText()).replace(/\s+/g, ' ').trim();
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

test('every kind of step is one kind of row: the same head, the same card, a sentence, no "Completed", no "0.0s"', () => using(async ({ page }) => {
  await unfold(page);
  const turn = page.locator('.turn').nth(2);
  await turn.locator('.activity-group > summary').first().click();
  const steps = turn.locator('.step');
  await steps.nth(4).waitFor();
  assert.equal(await steps.count(), 5);
  const titles = await steps.locator('> .step-head').evaluateAll(heads => heads.map(head => [...head.querySelectorAll(':scope > .step-title, :scope > .step-meta')].map(part => part.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')));
  assert.deepEqual(titles, ['Ran ls notes', 'Ran npm test 0.8s', 'Used rag search 1.4s', 'Searched two-pass parser design', 'Edited app.ts …/parity-fixture/src +1 −1'], 'sentences, with a duration only from 0.1 s');
  assert.doesNotMatch(await turn.innerText(), /Completed|0\.0s/);
  // Open every closed one; then every head and every card is drawn the same way.
  for (const head of await turn.locator('.step > summary.step-head').all()) if (!(await head.evaluate(node => node.parentElement.open))) await head.click();
  await turn.locator('.step-card').nth(4).waitFor();
  await page.mouse.move(0, 0); await page.waitForTimeout(200); // compare every head at rest, after the hover transition
  const looks = await turn.locator('.step-head').evaluateAll(heads => heads.map(head => { const style = getComputedStyle(head), box = head.getBoundingClientRect(); return [style.fontSize, style.color, style.display, Math.round(box.left), Math.round(box.height)].join('|'); }));
  assert.equal(new Set(looks).size, 1, `one head style, aligned: ${JSON.stringify(looks)}`);
  const cards = await turn.locator('.step-card').evaluateAll(nodes => nodes.map(node => { const style = getComputedStyle(node); return [style.borderRadius, style.borderTopWidth, style.borderTopColor, style.backgroundColor, Math.round(node.getBoundingClientRect().left)].join('|'); }));
  assert.ok(cards.length >= 5, `every step has a card (${cards.length})`);
  assert.equal(new Set(cards).size, 1, `one card style: ${JSON.stringify([...new Set(cards)])}`);
}));

test('light and dark: the rows, counts and diff are legible and inside the chat column', async () => {
  for (const colorScheme of ['light', 'dark']) await using(async ({ page }) => {
    await unfold(page);
    const group = page.locator('.activity-group').filter({ hasText: /^Edited parser\.ts/ }).first();
    await group.locator('> summary').click();
    await group.locator('.step > .step-head').first().click();
    await group.locator('.step-card').waitFor();
    const column = await page.locator('.turn').first().boundingBox(), page_ = await page.evaluate(() => window.__rgb(getComputedStyle(document.body).backgroundColor));
    for (const locator of [group.locator('> summary'), group.locator('.step-head').first(), group.locator('.step-card'), page.locator('.turn-changes').first()]) {
      const box = await locator.boundingBox();
      assert.ok(box.x >= column.x - 8 && box.x + box.width <= column.x + column.width + 1, `${colorScheme}: ${await locator.evaluate(node => node.className || node.tagName)} fits the column`);
    }
    const title = await group.locator('> summary .activity-group-label').boundingBox(), counts = await group.locator('> summary .change-counts').boundingBox();
    assert.ok(title.x + title.width <= counts.x + 1, `${colorScheme}: the counts do not overlap the label`);
    for (const sign of ['.add', '.del']) {
      const colour = await group.locator(`> summary .change-counts ${sign}`).evaluate(node => window.__rgb(getComputedStyle(node).color));
      assert.ok(contrast(colour, page_) >= 3.2, `${colorScheme}: ${sign} counts read against the page (${colour} on ${page_}: ${contrast(colour, page_).toFixed(2)})`);
    }
    await page.screenshot({ path: `/tmp/chat-edits-${colorScheme}.png` });
  }, { colorScheme });
});
