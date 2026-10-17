// The review surface: a "Changes" tab in the side panel with the chat's working-tree changes (file list, +/- counts,
// coloured diff with line numbers), refreshing while a turn runs, and a confirmed per-file Discard. The exported UI
// against a scripted desktop bridge (tests/fake-desktop.cjs) and a synthetic bridge HTTP/SSE server: no engine, no Git,
// no provider. Screenshots go to $ELPIS_CHANGES_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { guardDesktopStore, oranges } = require('./controls.cjs');
const { fakeDesktop } = require('./fake-desktop.cjs');
const root = path.resolve(__dirname, '../out');
const shots = process.env.ELPIS_CHANGES_SHOTS;
async function eventually(check, ms = 7000) {
  const deadline = Date.now() + ms;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 60)); } }
}

const PARSER = 'diff --git a/src/parser.ts b/src/parser.ts\nindex 1111111..2222222 100644\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -10,4 +10,5 @@ export function parse(tokens: Token[]) {\n   const tree = [];\n-  for (const token of tokens) tree.push(token);\n+  for (const token of tokens) {\n+    tree.push(insert(token));\n+  }\n   return tree;\n';
const README = 'diff --git a/README.md b/README.md\nindex 3333333..4444444 100644\n--- a/README.md\n+++ b/README.md\n@@ -1,2 +1,3 @@\n # Parser\n+A tiny parser.\n Usage below.\n';
const OLD = 'diff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-gone one\n-gone two\n';
const files = () => [
  { path: 'README.md', status: 'modified', added: 1, removed: 0, binary: false },
  { path: 'old.txt', status: 'deleted', added: 0, removed: 2, binary: false },
  { path: 'src/parser.ts', status: 'modified', added: 3, removed: 1, binary: false },
];

async function fixture(run, { width = 1130, height = 660, colorScheme = 'light' } = {}) {
  const thread = { id: 'chat-one', name: 'Fix the parser', preview: 'Fix the parser', cwd: '/work/parser/src', model: 'gpt-6-luna', modelProvider: 'openai', status: { type: 'idle' } };
  const state = { files: files(), diffs: { 'README.md': README, 'old.txt': OLD, 'src/parser.ts': PARSER }, root: '/work/parser', error: null, posts: [], reads: [] };
  const clients = new Set();
  const emit = (method, params) => { for (const client of clients) client.write(`event: message\ndata: ${JSON.stringify({ method, params })}\n\n`); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = (value, status = 200) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return; }
    if (url.pathname === '/api/health') return json({ connected: true, cwd: '/work/parser/src' });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }], nextCursor: null });
    if (url.pathname === '/api/threads') return json({ data: url.searchParams.get('ancestorThreadId') ? [] : [thread], nextCursor: null });
    if (url.pathname === '/api/threads/chat-one/git' && req.method === 'GET') {
      state.reads.push(url.search);
      if (state.error) return json({ error: state.error }, 409);
      if (url.searchParams.get('view') === 'changes') return json({ root: state.root, files: state.files, truncated: false });
      if (url.searchParams.get('view') === 'file') return json({ diff: state.diffs[url.searchParams.get('path')] ?? '', truncated: false, binary: false });
    }
    if (url.pathname === '/api/threads/chat-one/git' && req.method === 'POST') {
      const body = JSON.parse(raw); state.posts.push(body);
      state.files = state.files.filter(file => file.path !== body.path); return json({ discarded: body.path });
    }
    if (url.pathname.endsWith('/resume')) return json({ thread, activeTurnId: null });
    if (url.pathname === '/api/threads/chat-one') return json({ thread, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    try { const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname); const content = await fs.readFile(file); res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, colorScheme }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await guardDesktopStore(page);
    await page.addInitScript(fakeDesktop, { tabs: [] });
    await page.addInitScript(() => { window.__opened = []; window.elpisDesktop.openFolder = async folder => { window.__opened.push(folder); }; });
    await page.goto(`http://127.0.0.1:${server.address().port}/#token=fixture`);
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator('.thread-row[data-thread-id="chat-one"] .thread-link').click();
    await page.getByRole('button', { name: 'Show side panel' }).click();
    const side = page.getByRole('region', { name: 'Side panel' });
    const shoot = async name => { if (shots) { await fs.mkdir(shots, { recursive: true }); await page.waitForTimeout(350); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };
    await run({ page, side, state, emit, shoot });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); }
}

const openChanges = async ({ page, side }) => {
  await side.getByRole('button', { name: 'New side panel tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Changes', exact: true }).click();
};

test('Changes tab: the working-tree file list with status and +/- counts, and the selected file\'s coloured, numbered diff', async () => {
  await fixture(async ({ page, side, state, shoot }) => {
    await openChanges({ page, side });
    const tab = side.getByRole('tab', { name: 'Changes', exact: true });
    await tab.waitFor(); assert.equal(await tab.getAttribute('aria-selected'), 'true');
    const rows = side.getByRole('list', { name: 'Changed files' }).getByRole('listitem');
    await eventually(async () => assert.equal(await rows.count(), 3));
    assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.querySelector('.change-path')?.textContent)), ['README.md', 'old.txt', 'src/parser.ts']);
    assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.querySelector('.change-status')?.getAttribute('title'))), ['Modified', 'Deleted', 'Modified']);
    assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.querySelector('.change-counts')?.textContent.replace(/\s+/g, ' ').trim())), ['+1 −0', '+0 −2', '+3 −1']);
    assert.match(await side.locator('.changes-summary').innerText(), /3 files changed/); assert.match(await side.locator('.changes-summary').innerText(), /\+4\s*−3/);
    assert.ok(state.reads.length > 0, "the list came from the bridge");

    // The first file is open; its added lines are green and removed lines red, with the numbers of both files.
    const diff = side.getByRole('region', { name: 'Diff of README.md' });
    await diff.waitFor(); await diff.locator('.diff-line.add').waitFor();
    assert.equal(await diff.locator('.diff-line.add').count(), 1);
    const [added, ctx] = [diff.locator('.diff-line.add'), diff.locator('.diff-line.ctx').first()];
    assert.deepEqual(await ctx.locator('.diff-no').allInnerTexts(), ['1', '1'], 'a unchanged line has both numbers');
    assert.deepEqual(await added.locator('.diff-no').allInnerTexts(), ['', '2'], 'an added line has only its new number');
    assert.equal(await added.locator('.diff-text').innerText(), 'A tiny parser.');

    // A real click on another file shows that file's diff; its colours come from the same two rules.
    await rows.nth(2).getByRole('button').click();
    const parser = side.getByRole('region', { name: 'Diff of src/parser.ts' }); await parser.waitFor();
    await parser.locator('.diff-line.del').first().waitFor();
    assert.equal(await parser.locator('.diff-line.add').count(), 3); assert.equal(await parser.locator('.diff-line.del').count(), 1);
    assert.deepEqual(await parser.locator('.diff-line.del .diff-no').allInnerTexts(), ['11', '']);
    // The colour a line is drawn with, as red, green, blue over the page (read back from a canvas pixel).
    const paint = locator => locator.evaluate(element => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const context = canvas.getContext('2d', { willReadFrequently: true });
      context.fillStyle = '#fbfbfa'; context.fillRect(0, 0, 1, 1); context.fillStyle = getComputedStyle(element).backgroundColor; context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    });
    const [green, red, plain] = [await paint(parser.locator('.diff-line.add').first()), await paint(parser.locator('.diff-line.del').first()), await paint(parser.locator('.diff-line.ctx').first())];
    assert.ok(green[1] > green[0] && green[1] > green[2], `added lines are tinted green (${green})`);
    assert.ok(red[0] > red[1] && red[0] > red[2], `removed lines are tinted red (${red})`);
    assert.ok(plain.join() !== green.join() && plain.join() !== red.join(), 'unchanged lines are not tinted');
    const widths = await parser.locator('.diff-line:not(.hunk)').evaluateAll(lines => lines.map(line => Math.round(line.getBoundingClientRect().width)));
    assert.ok(widths.length > 3 && Math.max(...widths) - Math.min(...widths) <= 1, `every line is as wide as the longest, so the colours end together (${widths})`);
    assert.equal(await rows.nth(2).getByRole('button').getAttribute('aria-current'), 'true', 'the shown file is marked in the list');
    assert.deepEqual(await oranges(page), [], 'light theme, Changes tab: no orange');
    await shoot('changes-light');
  });
});

test('Changes tab: refreshes while a turn runs and once more when it ends', async () => {
  await fixture(async ({ page, side, state, emit }) => {
    await openChanges({ page, side });
    const rows = side.getByRole('list', { name: 'Changed files' }).getByRole('listitem');
    await eventually(async () => assert.equal(await rows.count(), 3));
    emit('turn/started', { threadId: 'chat-one', turn: { id: 'turn-1' } });
    await side.getByRole('button', { name: 'Discard', exact: true }).waitFor();
    assert.equal(await side.getByRole('button', { name: 'Discard', exact: true }).isDisabled(), true, 'a file the agent is writing cannot be discarded');
    // The agent edits a file and adds one; nothing is clicked, yet the list and the open diff follow.
    state.files = [...state.files, { path: 'src/lexer.ts', status: 'untracked', added: 7, removed: 0, binary: false }];
    state.files[0] = { ...state.files[0], added: 2 };
    state.diffs['README.md'] = README.replace('+A tiny parser.\n', '+A tiny parser.\n+With tests.\n');
    await eventually(async () => assert.equal(await rows.count(), 4));
    assert.equal(await rows.nth(3).locator('.change-counts').innerText().then(text => text.replace(/\s+/g, ' ').trim()), '+7 −0');
    await eventually(async () => assert.equal(await side.getByRole('region', { name: 'Diff of README.md' }).locator('.diff-line.add').count(), 2), 7000);
    // The turn ends with one last change; the final read picks it up.
    state.files = [...state.files, { path: 'src/last.ts', status: 'added', added: 1, removed: 0, binary: false }];
    emit('turn/completed', { threadId: 'chat-one', turn: { id: 'turn-1', status: 'completed' } });
    await eventually(async () => assert.equal(await rows.count(), 5));
    await eventually(async () => assert.equal(await side.getByRole('button', { name: 'Discard', exact: true }).isDisabled(), false));
    // Idle, the tab stops asking.
    await page.waitForTimeout(300); const before = state.reads.length; await page.waitForTimeout(3300);
    assert.equal(state.reads.length, before, 'no reads while idle');
  });
});

test('Changes tab: Discard asks first, and only the confirmed file goes; no commit, push, pull request or editor actions', async () => {
  await fixture(async ({ page, side, state, shoot }) => {
    await openChanges({ page, side });
    const rows = side.getByRole('list', { name: 'Changed files' }).getByRole('listitem');
    await eventually(async () => assert.equal(await rows.count(), 3));
    await rows.nth(1).getByRole('button').click(); await side.getByRole('region', { name: 'Diff of old.txt' }).waitFor();
    const dialog = page.getByRole('alertdialog');
    await side.getByRole('button', { name: 'Discard', exact: true }).click();
    await dialog.waitFor(); assert.match(await dialog.innerText(), /Discard changes to old\.txt\?/); assert.match(await dialog.innerText(), /cannot be undone/i);
    await shoot('changes-discard-dialog');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(state.posts, [], 'cancelling discards nothing'); assert.equal(await rows.count(), 3);
    await page.keyboard.press('Escape'); // nothing is open any more; Escape must not discard either
    await side.getByRole('button', { name: 'Discard', exact: true }).click(); await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(state.posts, [{ action: 'discard', path: 'old.txt' }], 'one request, for that file only');
    await eventually(async () => assert.equal(await rows.count(), 2));
    assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.querySelector('.change-path')?.textContent)), ['README.md', 'src/parser.ts']);
    // Nothing here commits, pushes or publishes, and nothing opens an editor.
    const labels = await side.getByRole('button').evaluateAll(buttons => buttons.map(button => `${button.getAttribute('aria-label') ?? ''} ${button.textContent}`.trim()));
    assert.deepEqual(labels.filter(label => /commit|push|pull request|\bPR\b|publish|editor|vs ?code/i.test(label)), []);
  });
});

test('Changes tab: Show in folder opens the changed file\'s folder; a folder that is not a repository says so', async () => {
  await fixture(async ({ page, side, state }) => {
    await openChanges({ page, side });
    const rows = side.getByRole('list', { name: 'Changed files' }).getByRole('listitem');
    await eventually(async () => assert.equal(await rows.count(), 3));
    await rows.nth(2).getByRole('button').click(); await side.getByRole('region', { name: 'Diff of src/parser.ts' }).waitFor();
    await side.getByRole('button', { name: 'Show in folder', exact: true }).click();
    await eventually(async () => assert.deepEqual(await page.evaluate(() => window.__opened), ['/work/parser/src']));
    await rows.nth(0).getByRole('button').click(); await side.getByRole('region', { name: 'Diff of README.md' }).waitFor();
    await side.getByRole('button', { name: 'Show in folder', exact: true }).click();
    await eventually(async () => assert.deepEqual(await page.evaluate(() => window.__opened), ['/work/parser/src', '/work/parser']));
    state.error = "This chat's folder is not a Git repository.";
    await side.getByRole('button', { name: 'Refresh changes', exact: true }).click();
    await eventually(async () => assert.match(await side.getByRole('alert').innerText(), /not a Git repository/));
    state.error = null; state.files = [];
    await side.getByRole('button', { name: 'Refresh changes', exact: true }).click();
    await eventually(async () => assert.match(await side.innerText(), /No changes in this folder\./));
  });
});

test('Changes tab: dark theme, same layout, nothing cut off', async () => {
  await fixture(async ({ page, side, shoot }) => {
    await page.locator('.app-shell.dark').waitFor();
    await openChanges({ page, side });
    await eventually(async () => assert.equal(await side.getByRole('list', { name: 'Changed files' }).getByRole('listitem').count(), 3));
    await side.getByRole('region', { name: 'Diff of README.md' }).locator('.diff-line.add').waitFor();
    const clipped = await side.evaluate(element => [...element.querySelectorAll('.changes-head, .changes-summary, .change-row, .diff-head, .diff-head button')].filter(node => node.getClientRects().length && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflow === 'visible').map(node => node.className));
    assert.deepEqual(clipped, [], 'no control spills out of the panel');
    await shoot('changes-dark');
  }, { colorScheme: 'dark' });
});
