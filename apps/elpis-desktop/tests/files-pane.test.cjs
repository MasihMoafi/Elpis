// File paths in replies and the Files pane, as Claude's desktop app has them: a path in a reply is a button that opens the
// file in the side panel's Files tab at its lines and shows it in the project tree; the tab is a real tree (folders open
// and close, a filter finds by name, "?" searches the contents), open files are tabs, and a file can be edited in place and
// saved. "Open in" starts an editor (never VS Code) or the system's default app. The exported UI against the real bridge
// file functions (bridge/files.mjs) on a temporary project at /tmp/parity-fixture, in a fake desktop (tests/parity-fixture.cjs).
// Screenshots go to $ELPIS_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { fixture } = require('./parity-fixture.cjs');
const { unapprovedOranges } = require('./controls.cjs');
const CWD = path.join(os.homedir(), '.cache', `elpis-file-previews-${process.pid}`);
const trashProject = async () => { if (await fs.stat(CWD).catch(() => null)) await execFile('gio', ['trash', CWD]); };
/** Retries `check` until it stops throwing: a folder is read by the bridge after the click that opens it. */
async function eventually(check, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) { try { return await check(); } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 60)); } }
}

const PROJECT = {
  'README.md': `# Parser\nA tiny parser.\nUsage below. ${'https://rag-web-deployment-preview-0123456789abcdef.vercel.app/'.repeat(4)}\n`,
  'package.json': '{\n  "name": "parser"\n}\n',
  'docs/guide.md': 'Guide\nSee the parser section.\nEnd of guide.\n',
  'src/app.ts': 'import { parse } from "./lib/parser";\nparse();\n',
  'src/lib/parser.ts': 'export function parse(tokens: string[]) {\n  const tree = [];\n  for (const token of tokens) tree.push(token);\n  return tree;\n}\n',
  'src/lib/lexer.ts': 'export const lex = (s: string) => s.split(" ");\nexport const done = true;\n',
  'docs/report.html': '<h1>Report</h1>',
};
async function writeProject() {
  await trashProject();
  for (const [file, content] of Object.entries(PROJECT)) { await fs.mkdir(path.dirname(path.join(CWD, file)), { recursive: true }); await fs.writeFile(path.join(CWD, file), content); }
}
/** The bridge's own file functions answering the fixture's routes; a refusal is its 4xx status and message. */
async function routes() {
  const files = await import('../bridge/files.mjs');
  const answer = async run => { try { return await run(); } catch (error) { return { __http: error.status ?? 500, error: error.message }; } };
  let backend;
  const assetServer = () => backend ??= (async () => {
    const { startDesktopServer } = await import('../bridge/server.mjs');
    const app = await startDesktopServer({ client: { on() {}, off() {}, close() {}, connected: true, pendingApprovals: [], ragEnvironment: async () => ({}) }, staticDir: CWD, elpisHome: path.join(CWD, '.elpis-test-home'), loveSpot: { directory: path.join(CWD, '.love-spot'), screenshots: path.join(CWD, '.screenshots') } });
    const launch = new URL(app.url);
    const auth = await fetch(`${launch.origin}/api/session`, { method: 'POST', headers: { Origin: launch.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: new URLSearchParams(launch.hash.slice(1)).get('token') }) });
    return { ...app, origin: launch.origin, cookie: auth.headers.get('set-cookie').split(';')[0] };
  })();
  return {
    close: async () => { if (backend) await (await backend).close(); },
    '/api/files/dir': (_body, url) => answer(() => files.listDirectory(url.searchParams.get('cwd'), url.searchParams.get('dir') ?? '', url.searchParams.get('hidden') === '1')),
    '/api/file': (body, url) => answer(() => body ? files.writeFile(body.cwd, body.path, body.content, body.mtimeMs) : files.readFile(url.searchParams.get('cwd'), url.searchParams.get('path'))),
    '/api/file/asset': (_body, url) => answer(async () => {
      const app = await assetServer(), response = await fetch(`${app.origin}${url.pathname}${url.search}`, { headers: { Cookie: app.cookie } });
      if (!response.ok) return { __http: response.status, error: (await response.json()).error };
      return { __asset: { bytes: Buffer.from(await response.arrayBuffer()), mimeType: response.headers.get('content-type'), headers: Object.fromEntries(['content-security-policy', 'x-frame-options', 'cache-control', 'x-content-type-options'].map(name => [name, response.headers.get(name)])) } };
    }),
    '/api/files/search': (_body, url) => answer(() => files.searchFiles(url.searchParams.get('cwd'), url.searchParams.get('q'))),
    '/api/dev-servers/page': body => ({ url: `http://127.0.0.1:4999/${'a'.repeat(32)}/${body.path}`, asked: body }),
  };
}
const REPLY = [
  'The parser is in `src/lib/parser.ts:2-3`; `lexer.ts` is a separate file.',
  `See [the lexer](src/lib/lexer.ts#L1-L2), [the app](file://${CWD}/src/app.ts#L1) and ${CWD}/docs/guide.md:2 in the guide.`,
  'Run `npm run build`. Outside the project: `/etc/hosts.conf:3`. The page: `docs/report.html`.',
].join('\n\n');
const TURNS = [['t1', 'Where is the parser?', REPLY], ['t2', 'Run them.', 'All green.']];

test('quit safety reads every project document, keeps refused saves dirty, and clears only after save or revert', async () => {
  const second = '/tmp/second-file-project', original = 'export const exact = 1;\n', changed = 'export const exact = 821; // متن فارسی\n';
  const disk = new Map([[`${CWD}/src/a.ts`, original], [`${second}/src/b.ts`, original]]); let failSave = false, version = 1, pauseSave = false, releaseSave, saveStarted;
  const pendingSave = new Promise(resolve => saveStarted = resolve);
  const threads = [['chat-a', CWD], ['chat-b', second]].map(([id, cwd]) => ({ id, cwd, name: id, model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } }));
  const f = await fixture({ cwd: CWD, chat: [['file-guard', 'Show the file', '`src/a.ts`'], ['file-guard-tail', 'Ready', 'All green.']], routes: {
    '/api/threads': (_body, url) => ({ data: url.searchParams.get('archived') === 'true' || url.searchParams.has('ancestorThreadId') ? [] : threads, nextCursor: null }),
    '/api/threads/chat-b': () => ({ thread: threads[1], data: [{ turnId: 'second-file', item: { id: 'second-file', type: 'agentMessage', text: '`src/b.ts`' } }], nextCursor: null }),
    '/api/threads/chat-b/resume': () => ({ thread: threads[1], activeTurnId: null }),
    '/api/files/dir': (_body, url) => ({ data: url.searchParams.get('cwd') === second ? [{ name: 'b.ts', dir: false }] : [] }),
    '/api/file': async (body, url) => {
      if (body && failSave) return { __http: 409, error: 'Private file save refused' };
      const key = body ? `${body.cwd}/${body.path}` : `${url.searchParams.get('cwd')}/${url.searchParams.get('path')}`;
      if (body && pauseSave) { saveStarted(); await new Promise(resolve => releaseSave = resolve); }
      if (body) { disk.set(key, body.content); return { mtimeMs: ++version }; }
      return { content: disk.get(key), size: disk.get(key)?.length ?? 0, mtimeMs: version };
    },
  } });
  const dirty = () => f.page.evaluate(() => window.__elpisHasUnsavedFiles);
  const editor = file => f.page.getByRole('textbox', { name: `Contents of ${file}`, exact: true });
  const saveFile = () => f.page.getByRole('region', { name: 'File viewer' }).getByRole('button', { name: 'Save', exact: true }).click();
  try {
    await f.open('chat-a'); await f.page.locator('.message.agent').getByRole('button', { name: 'src/a.ts', exact: true }).click();
    await editor('src/a.ts').fill(changed); assert.equal(await dirty(), true, 'actual typed file edits are exposed');
    assert.equal(await f.page.evaluate(() => Reflect.set(window, '__elpisHasUnsavedFiles', false)), false, 'the status is read-only'); assert.equal(await dirty(), true);
    assert.equal(disk.get(`${CWD}/src/a.ts`), original, 'the safety probe never writes source files');
    await f.page.getByRole('button', { name: 'Close side panel', exact: true }).click(); assert.equal(await dirty(), true, 'hidden pane edits remain dirty');
    await f.open('chat-b'); await f.page.locator('.message.agent').getByRole('button', { name: 'src/b.ts', exact: true }).click();
    await editor('src/b.ts').fill(changed); await saveFile();
    await eventually(async () => assert.equal(disk.get(`${second}/src/b.ts`), changed));
    assert.equal(await dirty(), true, 'saving the current project cannot hide edits in another project');
    await f.open('chat-a'); assert.equal(await editor('src/a.ts').inputValue(), changed);
    failSave = true; await saveFile(); await f.page.getByRole('alert').filter({ hasText: 'Private file save refused' }).waitFor();
    assert.equal(await dirty(), true); assert.equal(await editor('src/a.ts').inputValue(), changed); assert.equal(disk.get(`${CWD}/src/a.ts`), original);
    failSave = false; await saveFile(); await f.page.waitForFunction(() => window.__elpisHasUnsavedFiles === false);
    assert.equal(disk.get(`${CWD}/src/a.ts`), changed);
    await editor('src/a.ts').fill(changed + '// deliberately reverted\n'); assert.equal(await dirty(), true);
    await f.page.getByRole('button', { name: 'Revert changes', exact: true }).click(); assert.equal(await dirty(), false); assert.equal(await editor('src/a.ts').inputValue(), changed);
    pauseSave = true; await editor('src/a.ts').fill(changed + '// pending save\n'); await saveFile(); await pendingSave;
    await f.page.getByRole('button', { name: 'Revert changes', exact: true }).click();
    assert.equal(await editor('src/a.ts').inputValue(), changed); assert.equal(await dirty(), true, 'a write still in flight blocks even when current text equals its old saved text');
    releaseSave(); await f.page.getByRole('button', { name: 'Save', exact: true }).waitFor();
    assert.equal(await dirty(), true, 'acknowledging different sent text keeps the current local text dirty');
    await f.page.getByRole('button', { name: 'Revert changes', exact: true }).click(); assert.equal(await dirty(), false);
    assert.equal(await editor('src/a.ts').inputValue(), changed + '// pending save\n');
    assert.deepEqual(f.errors, []);
  } finally { releaseSave?.(); await f.close(); }
});

/** The desktop calls the pane makes, recorded in the page: the system's app, the folder, the editors installed and one started. */
const prepare = (page, editors) => page.evaluate(editors => {
  window.__opened = []; window.__edited = [];
  window.elpisDesktop.openExternalFile = async target => { window.__opened.push(target); };
  window.elpisDesktop.openFolder = async target => { window.__folder = target; };
  window.elpisDesktop.editors = async () => editors;
  window.elpisDesktop.openInEditor = async (target, editor, line) => { window.__edited.push({ target, editor, line }); };
}, editors);
async function open({ editors = [], ...options } = {}) {
  await writeProject();
  const handlers = await routes();
  const f = await fixture({ chat: TURNS, cwd: CWD, routes: handlers, width: 1400, height: 800, ...(process.env.ELPIS_TEST_STATIC_DIR ? { staticDir: process.env.ELPIS_TEST_STATIC_DIR } : {}), ...options });
  await prepare(f.page, editors);
  await f.open('chat-a');
  const side = f.page.getByRole('region', { name: 'Side panel' });
  const view = side.getByRole('region', { name: 'File viewer' });
  const tree = side.getByRole('tree', { name: 'Project files' });
  const tabs = side.getByRole('tablist', { name: 'Open files' });
  const row = name => tree.getByRole('treeitem', { name, exact: true });
  const editor = file => side.getByRole('textbox', { name: `Contents of ${file}`, exact: true });
  const shot = async name => { if (process.env.ELPIS_SHOTS) { await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await f.page.waitForTimeout(400); await f.page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `${name}.png`) }); } };
  const ref = name => f.page.locator('.message.agent').first().getByRole('button', { name, exact: true });
  return { ...f, close: async () => { await f.close(); await handlers.close(); await trashProject(); }, side, view, tree, tabs, row, editor, shot, ref };
}
async function openFilesTab(f) {
  await f.page.getByRole('button', { name: 'Show side panel' }).click();
  await f.side.getByRole('button', { name: 'New side panel tab', exact: true }).click();
  await f.page.getByRole('menuitem', { name: 'Files', exact: true }).click();
  await f.tree.waitFor();
}
const lit = f => f.side.locator('.fe-line.hit').evaluateAll(lines => lines.map(line => line.textContent));

test('Markdown opens as a document; source editing and relative links/images keep their file context', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const f = await open({ colorScheme });
    try {
      const document = '# Project tasks\n\n| Task | Status |\n| --- | --- |\n| File previews | Working |\n\n[Open the guide](guide.md)\n\n![Preview diagram](picture.png)\n\n![Remote](https://example.invalid/spy.png)\n\n![Outside](../../outside.png)\n\n<script>window.markdownExecuted=true</script>\n';
      await fs.writeFile(path.join(CWD, 'docs/preview.md'), document);
      await fs.writeFile(path.join(CWD, 'docs/picture.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64'));
      const requested = [];
      f.page.on('request', request => { if (/spy\.png|outside\.png/.test(request.url())) requested.push(request.url()); });
      await openFilesTab(f); await f.row('docs').click(); await f.row('preview.md').click();
      await f.view.getByRole('heading', { name: 'Project tasks', exact: true }).waitFor();
      assert.equal(await f.editor('docs/preview.md').count(), 0, 'the default is the document, not markup');
      assert.deepEqual(await f.view.getByRole('cell').allInnerTexts(), ['File previews', 'Working']);
      const image = f.view.getByRole('img', { name: 'Preview diagram', exact: true });
      await eventually(async () => assert.equal(await image.evaluate(node => node.complete && node.naturalWidth), 8));
      assert.deepEqual(requested, [], 'remote images and paths outside the project are not loaded');
      assert.equal(await f.page.evaluate(() => window.markdownExecuted), undefined, 'Markdown HTML is never executed');
      await f.shot(`files-markdown-${colorScheme}`);
      await f.view.getByRole('button', { name: 'Source', exact: true }).click();
      await f.editor('docs/preview.md').fill(`${document}\n## Unsaved edit\n`);
      await f.view.getByRole('button', { name: 'Preview', exact: true }).click();
      await f.view.getByRole('heading', { name: 'Unsaved edit', exact: true }).waitFor();
      await f.view.getByRole('button', { name: 'Source', exact: true }).click();
      assert.equal(await f.editor('docs/preview.md').inputValue(), `${document}\n## Unsaved edit\n`, 'switching views preserves the draft');
      await f.editor('docs/preview.md').focus(); await f.page.keyboard.press('Control+s');
      await eventually(async () => assert.equal(await fs.readFile(path.join(CWD, 'docs/preview.md'), 'utf8'), `${document}\n## Unsaved edit\n`));
      await f.view.getByRole('button', { name: 'Preview', exact: true }).click();
      await f.view.getByRole('button', { name: 'Open the guide', exact: true }).click();
      await eventually(async () => assert.equal(await f.tabs.getByRole('tab', { name: 'guide.md', exact: true }).getAttribute('aria-selected'), 'true'));
      await eventually(async () => assert.match(await f.view.innerText(), /See the parser section/));
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

/** Two real PDF pages with distinct visible content and proper object offsets. No renderer or inference is involved. */
function previewPdf() {
  const texts = ['Elpis document preview', 'Second page: previews work'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  for (let index = 0; index < 2; index++) {
    const stream = `BT /F1 24 Tf 32 400 Td (${texts[index]}) Tj ET\n`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 480] /Resources << /Font << /F1 7 0 R >> >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('PDF files open in a document frame, served as a PDF, instead of raw bytes in an editor', async () => {
  const f = await open();
  try {
    await fs.writeFile(path.join(CWD, 'report.pdf'), previewPdf());
    await openFilesTab(f); await f.row('report.pdf').click();
    const preview = f.view.locator('iframe[title="Preview of report.pdf"]');
    await preview.waitFor();
    assert.equal(await f.editor('report.pdf').count(), 0);
    // What Elpis owns is the frame and the file it serves; drawing the pages is the browser's own viewer.
    const served = await f.page.evaluate(async src => { const response = await fetch(src); return { status: response.status, type: response.headers.get('content-type'), head: (await response.text()).slice(0, 8) }; }, await preview.getAttribute('src'));
    assert.deepEqual(served, { status: 200, type: 'application/pdf', head: '%PDF-1.4' });
    await f.shot('files-pdf-light');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a path in a reply is a button that opens the Files tab on the file at its lines and shows it in the tree', async () => {
  const f = await open();
  try {
    // Which of the reply's words are file refs: inline code that is a path, a Markdown link to a path, a file:/// address
    // and an absolute path in plain text. A bare name, a command and the rest stay as they were.
    for (const name of ['src/lib/parser.ts:2-3', 'the lexer', 'the app', `${CWD}/docs/guide.md:2`, '/etc/hosts.conf:3']) assert.equal(await f.ref(name).count(), 1, name);
    assert.equal(await f.ref('lexer.ts').count(), 0, 'a name with no folder is not a ref');
    assert.equal(await f.ref('npm run build').count(), 0);
    assert.equal(await f.page.getByRole('region', { name: 'Side panel' }).count(), 0, 'nothing is open before a click');

    await f.ref('src/lib/parser.ts:2-3').click();
    assert.equal(await f.side.getByRole('tab', { name: 'Files', exact: true }).getAttribute('aria-selected'), 'true');
    // A short label still puts its × at the tab's right end, as on chat tabs (Masih's screenshot 19:35).
    const filesTab = await f.side.locator('.task-tab', { has: f.page.getByRole('tab', { name: 'Files', exact: true }) }).boundingBox();
    const filesClose = await f.side.getByRole('button', { name: 'Close Files tab', exact: true }).boundingBox();
    assert.ok(filesTab.x + filesTab.width - (filesClose.x + filesClose.width) <= 6, 'the close button sits at the right end');
    const parser = f.tabs.getByRole('tab', { name: 'parser.ts', exact: true });
    assert.equal(await parser.getAttribute('aria-selected'), 'true');
    await f.editor('src/lib/parser.ts').waitFor();
    assert.equal(await f.editor('src/lib/parser.ts').inputValue(), PROJECT['src/lib/parser.ts']);
    assert.deepEqual(await lit(f), ['  const tree = [];', '  for (const token of tokens) tree.push(token);'], 'lines 2 to 3 are marked');
    // The tree opened the folders on the way and shows the file selected, in view.
    for (const folder of ['src', 'lib']) assert.equal(await f.row(folder).getAttribute('aria-expanded'), 'true', folder);
    assert.equal(await f.row('parser.ts').getAttribute('aria-selected'), 'true');
    const [box, inner] = [await f.tree.boundingBox(), await f.row('parser.ts').boundingBox()];
    assert.ok(inner.y >= box.y && inner.y + inner.height <= box.y + box.height, 'the revealed row is inside the tree');
    await f.shot('files-ref-light');

    // The other forms, each in its own tab and with its own lines.
    await f.ref('the lexer').click();
    await f.editor('src/lib/lexer.ts').waitFor();
    assert.deepEqual(await lit(f), ['export const lex = (s: string) => s.split(" ");', 'export const done = true;']);
    await f.ref('the app').click();
    await f.editor('src/app.ts').waitFor();
    assert.deepEqual(await lit(f), ['import { parse } from "./lib/parser";']);
    await f.ref(`${CWD}/docs/guide.md:2`).click();
    await f.editor('docs/guide.md').waitFor();
    assert.deepEqual(await lit(f), ['See the parser section.']);
    assert.deepEqual(await f.tabs.getByRole('tab').allInnerTexts(), ['parser.ts', 'lexer.ts', 'app.ts', 'guide.md']);
    await f.tabs.getByRole('tab', { name: 'parser.ts', exact: true }).click();
    assert.deepEqual(await lit(f), ['  const tree = [];', '  for (const token of tokens) tree.push(token);'], 'a tab comes back as it was');

    // Outside references stay in Files, including unavailable-file feedback.
    await f.ref('/etc/hosts.conf:3').click();
    await f.view.getByRole('alert').waitFor();
    assert.deepEqual(await f.page.evaluate(() => window.__opened), []);
    assert.equal(await f.tabs.getByRole('tab').count(), 5);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the Files tab is a project tree: folders open and close by click and by key, one folder is read at a time', async () => {
  const f = await open();
  try {
    await openFilesTab(f);
    assert.equal(await f.side.getByRole('tab', { name: 'Files', exact: true }).getAttribute('aria-selected'), 'true');
    assert.match(await f.view.innerText(), /Pick a file in the tree, or click a file path in the conversation\./);
    await eventually(async () => assert.deepEqual(await f.tree.getByRole('treeitem').allInnerTexts(), ['docs', 'src', 'package.json', 'README.md'], 'folders first, then files, by name'));
    assert.equal(await f.row('src').getAttribute('aria-expanded'), 'false');
    await f.row('src').click();
    assert.equal(await f.row('src').getAttribute('aria-expanded'), 'true');
    await eventually(async () => assert.deepEqual(await f.tree.getByRole('treeitem').allInnerTexts(), ['docs', 'src', 'lib', 'app.ts', 'package.json', 'README.md']));
    assert.equal(await f.row('lib').getAttribute('aria-level'), '2');
    await f.row('lib').click();
    await eventually(async () => assert.deepEqual(await f.tree.getByRole('treeitem').allInnerTexts(), ['docs', 'src', 'lib', 'lexer.ts', 'parser.ts', 'app.ts', 'package.json', 'README.md']));
    await f.row('src').click();
    await eventually(async () => assert.deepEqual(await f.tree.getByRole('treeitem').allInnerTexts(), ['docs', 'src', 'package.json', 'README.md'], 'a closed folder hides what it held'));
    await f.row('src').click();
    assert.equal(await f.row('lib').getAttribute('aria-expanded'), 'true', 'and shows it again as it was');

    // Keys: arrows move, Right opens a folder, Left closes it or goes to its folder, Enter opens a file.
    await f.row('docs').focus();
    await f.page.keyboard.press('ArrowRight');
    assert.equal(await f.row('docs').getAttribute('aria-expanded'), 'true');
    await f.row('guide.md').waitFor();
    await f.page.keyboard.press('ArrowDown');
    assert.equal(await f.page.evaluate(() => document.activeElement?.textContent), 'guide.md');
    await f.page.keyboard.press('ArrowLeft');
    assert.equal(await f.page.evaluate(() => document.activeElement?.textContent), 'docs', 'Left on a file goes to its folder');
    await f.page.keyboard.press('ArrowLeft');
    assert.equal(await f.row('docs').getAttribute('aria-expanded'), 'false');
    await f.row('README.md').focus();
    await f.page.keyboard.press('Enter');
    await f.view.getByRole('heading', { name: 'Parser', exact: true }).waitFor();
    assert.match(await f.view.innerText(), /A tiny parser/);
    await f.shot('files-tree-light');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a click on a file previews it in a tab the next click replaces; a double click, or an edit, keeps it', async () => {
  const f = await open();
  try {
    await openFilesTab(f);
    await f.row('README.md').click();
    await f.view.getByRole('heading', { name: 'Parser', exact: true }).waitFor();
    assert.deepEqual(await f.tabs.getByRole('tab').allInnerTexts(), ['README.md']);
    assert.equal(await f.tabs.locator('.task-tab.preview').count(), 1, 'the tab is a preview');
    await f.row('package.json').click();
    await f.editor('package.json').waitFor();
    assert.deepEqual(await f.tabs.getByRole('tab').allInnerTexts(), ['package.json'], 'the preview was replaced');
    await f.row('package.json').dblclick();
    assert.equal(await f.tabs.locator('.task-tab.preview').count(), 0, 'a double click keeps it');
    await f.row('README.md').click();
    await f.view.getByRole('heading', { name: 'Parser', exact: true }).waitFor();
    assert.deepEqual(await f.tabs.getByRole('tab').allInnerTexts(), ['package.json', 'README.md']);
    await f.view.getByRole('button', { name: 'Source', exact: true }).click();
    await f.editor('README.md').click();
    await f.page.keyboard.press('End');
    await f.page.keyboard.type('!');
    assert.equal(await f.tabs.locator('.task-tab.preview').count(), 0, 'an edit keeps it');
    await f.row('docs').click(); await f.row('guide.md').click();
    assert.deepEqual(await f.tabs.getByRole('tab').allInnerTexts(), ['package.json', 'README.md', 'guide.md'], 'a kept tab stays when another is previewed');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the filter finds files by name from anywhere in the tree, and ? searches the contents', async () => {
  const f = await open();
  try {
    await openFilesTab(f);
    const filter = f.side.getByRole('textbox', { name: 'Filter files', exact: true });
    assert.equal(await filter.getAttribute('placeholder'), 'Filter files… (? for contents)');
    await filter.fill('lpar');
    assert.deepEqual(await f.tree.getByRole('treeitem').allInnerTexts(), ['parser.ts\nsrc/lib'], 'the file and its folder, found by letters in order');
    await filter.fill('guide');
    await f.tree.getByRole('treeitem').filter({ hasText: 'guide.md' }).click();
    await f.view.getByText(/See the parser section/).waitFor();
    await filter.fill('zzzz');
    assert.match(await f.side.locator('.files-tree').innerText(), /No matching files/);
    await filter.fill('');
    assert.deepEqual(await f.tree.getByRole('treeitem').allInnerTexts(), ['docs', 'src', 'package.json', 'README.md'], 'cleared, the tree is back');

    await filter.fill('?');
    assert.match(await f.side.locator('.files-tree').innerText(), /Type after \? to search file contents/);
    await filter.fill('?PARSER');
    const hits = f.tree.getByRole('treeitem');
    await hits.nth(1).waitFor();
    assert.deepEqual(await hits.allInnerTexts(), ['README.md', '1\n# Parser', '2\nA tiny parser.', 'guide.md\ndocs', '2\nSee the parser section.', 'package.json', '2\n"name": "parser"', 'app.ts\nsrc', '1\nimport { parse } from "./lib/parser";']);
    await hits.nth(4).click();
    await f.editor('docs/guide.md').waitFor();
    assert.deepEqual(await lit(f), ['See the parser section.'], 'a found line opens its file at that line');
    await filter.fill('?nothing-like-this');
    await f.side.getByText('No matches in file contents').waitFor();
    await f.shot('files-search-light');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a file is edited in place: the tab shows unsaved edits, Ctrl+S saves them, a file that changed on disk is not overwritten, a closed edit asks first', async () => {
  const f = await open();
  try {
    await f.ref('src/lib/parser.ts:2-3').click();
    const text = f.editor('src/lib/parser.ts');
    await text.waitFor();
    await text.click();
    await f.page.keyboard.press('Control+End');
    await f.page.keyboard.type('// done\n');
    const tab = f.tabs.getByRole('tab', { name: /parser\.ts/ });
    await f.tabs.getByRole('img', { name: 'Unsaved changes' }).waitFor();
    assert.equal(await fs.readFile(path.join(CWD, 'src/lib/parser.ts'), 'utf8'), PROJECT['src/lib/parser.ts'], 'nothing is written before the save');
    await f.page.keyboard.press('Control+s');
    await f.tabs.getByRole('img', { name: 'Unsaved changes' }).waitFor({ state: 'detached' });
    assert.equal(await fs.readFile(path.join(CWD, 'src/lib/parser.ts'), 'utf8'), `${PROJECT['src/lib/parser.ts']}// done\n`);
    const save = f.posts.filter(post => post.path === '/api/file').at(-1);
    assert.deepEqual([save.body.cwd, save.body.path, save.body.content], [CWD, 'src/lib/parser.ts', `${PROJECT['src/lib/parser.ts']}// done\n`]);

    // Saved again after another edit works (the new time was taken); a change made elsewhere is not overwritten.
    await f.page.keyboard.type('// more\n');
    await f.page.keyboard.press('Control+s');
    await f.tabs.getByRole('img', { name: 'Unsaved changes' }).waitFor({ state: 'detached' });
    await fs.writeFile(path.join(CWD, 'src/lib/parser.ts'), 'changed elsewhere\n'); await fs.utimes(path.join(CWD, 'src/lib/parser.ts'), new Date(), new Date(Date.now() + 9000));
    await f.page.keyboard.type('// mine\n');
    await f.page.keyboard.press('Control+s');
    await f.view.getByRole('alert').filter({ hasText: /changed on disk/ }).waitFor();
    assert.equal(await fs.readFile(path.join(CWD, 'src/lib/parser.ts'), 'utf8'), 'changed elsewhere\n');
    await f.tabs.getByRole('img', { name: 'Unsaved changes' }).waitFor();

    // Closing a tab with unsaved edits asks; Keep editing keeps it, Discard drops the edits.
    await f.tabs.getByRole('button', { name: 'Close parser.ts', exact: true }).click();
    const dialog = f.page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /Your edits to parser\.ts have not been saved\. Leaving this tab discards them\./);
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await tab.count(), 1);
    await f.tabs.getByRole('button', { name: 'Close parser.ts', exact: true }).click();
    await f.page.getByRole('alertdialog').getByRole('button', { name: 'Discard', exact: true }).click();
    await tab.waitFor({ state: 'detached' });
    assert.equal(await fs.readFile(path.join(CWD, 'src/lib/parser.ts'), 'utf8'), 'changed elsewhere\n', 'discarded edits never reached the file');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('open files and unsaved edits stay when another side-panel tab is shown', async () => {
  const f = await open();
  try {
    await f.ref('the lexer').click();
    const text = f.editor('src/lib/lexer.ts');
    await text.waitFor();
    await text.click(); await f.page.keyboard.type('x');
    await f.side.getByRole('button', { name: 'New side panel tab', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
    assert.equal(await f.view.count(), 0, 'the pane is not drawn behind another tab');
    await f.side.getByRole('tab', { name: 'Files', exact: true }).click();
    assert.match(await f.editor('src/lib/lexer.ts').inputValue(), /done = true;\nx$/);
    await f.tabs.getByRole('img', { name: 'Unsaved changes' }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('code is coloured by its language, as in a code block, and long lines wrap inside the pane by default', async () => {
  const f = await open();
  try {
    await f.ref('src/lib/parser.ts:2-3').click();
    const text = f.editor('src/lib/parser.ts');
    await text.waitFor();
    const colours = await f.view.locator('.fe-layer .hljs-keyword').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).color));
    assert.ok(colours.length >= 3, `keywords are marked (${colours.length})`);
    const plain = await text.evaluate(node => getComputedStyle(node).color);
    assert.ok(colours.every(colour => colour !== plain), `keywords have their own colour (${colours[0]} vs ${plain})`);
    assert.equal(await text.evaluate(node => getComputedStyle(node).webkitTextFillColor), 'rgba(0, 0, 0, 0)', 'the textarea draws only the caret and selection; the coloured layer shows the letters');
    await f.row('README.md').dblclick();
    await f.view.getByRole('button', { name: 'Source', exact: true }).click();
    const log = f.editor('README.md');
    await log.waitFor();
    const box = await log.evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth }));
    assert.ok(box.scroll <= box.client + 1, `a long line wraps instead of running past the pane (${box.scroll} > ${box.client})`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('an HTML file in a reply opens as a page in the built-in browser, served from its folder, not as text', async () => {
  const f = await open();
  try {
    await f.ref('docs/report.html').click();
    await eventually(async () => assert.deepEqual(await f.page.evaluate(() => window.__commands.filter(command => command.action === 'new').map(command => command.url)), [`http://127.0.0.1:4999/${'a'.repeat(32)}/report.html`]));
    const asked = f.posts.find(post => post.path === '/api/dev-servers/page');
    assert.deepEqual(asked.body, { cwd: `${CWD}/docs`, path: 'report.html' }, 'its folder is what gets served');
    assert.equal(await f.side.getByRole('textbox', { name: 'Contents of docs/report.html', exact: true }).count(), 0, 'not opened as text');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('find in file: Ctrl+F opens a bar that counts and steps through the matches, and Esc closes it', async () => {
  const f = await open();
  try {
    await f.ref('src/lib/parser.ts:2-3').click();
    const text = f.editor('src/lib/parser.ts');
    await text.waitFor(); await text.click();
    await f.page.keyboard.press('Control+f');
    const find = f.view.getByRole('textbox', { name: 'Find in file', exact: true });
    await find.waitFor();
    assert.equal(await f.page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Find in file');
    await find.fill('tree');
    const status = f.view.getByRole('status');
    assert.equal(await status.innerText(), 'Finding 1 of 3');
    assert.equal(await f.view.locator('.fe-find-hit').count(), 3, 'every match is marked');
    assert.equal(await f.view.locator('.fe-find-hit.current').count(), 1);
    await f.page.keyboard.press('Enter');
    assert.equal(await status.innerText(), 'Finding 2 of 3');
    await f.view.getByRole('button', { name: 'Next finding', exact: true }).click();
    assert.equal(await status.innerText(), 'Finding 3 of 3');
    await f.page.keyboard.press('Enter');
    assert.equal(await status.innerText(), 'Finding 1 of 3', 'after the last, the first');
    await f.view.getByRole('button', { name: 'Previous finding', exact: true }).click();
    assert.equal(await status.innerText(), 'Finding 3 of 3');
    await find.fill('zzz');
    assert.equal(await status.innerText(), 'No matches');
    await f.page.keyboard.press('Escape');
    await find.waitFor({ state: 'detached' });
    assert.equal(await f.view.locator('.fe-find-hit').count(), 0);
    assert.equal(await f.page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'the cursor is back in the file');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Open in: a path\'s menu offers the Files pane, each installed editor, the default app and the folder; the editor chosen is remembered', async () => {
  const f = await open({ editors: [{ id: 'zed', name: 'Zed' }, { id: 'gedit', name: 'gedit' }] });
  try {
    const ref = f.ref('src/lib/parser.ts:2-3');
    await ref.click({ button: 'right' });
    const menu = f.page.getByRole('menu');
    await menu.waitFor();
    assert.equal(await f.page.getByRole('menu').count(), 1, 'only the path\'s menu opens, not the message\'s');
    assert.deepEqual(await menu.getByRole('menuitem').allInnerTexts(), ['Open in Files pane', 'Open in Zed', 'Open in gedit', 'Open in default app', 'Show in folder', 'Copy absolute path', 'Copy relative path', 'Copy filename', 'Change this…']);
    await f.shot('files-open-in-menu');
    await menu.getByRole('menuitem', { name: 'Open in Zed', exact: true }).click();
    assert.deepEqual(await f.page.evaluate(() => window.__edited), [{ target: `${CWD}/src/lib/parser.ts`, editor: 'zed', line: 2 }]);
    assert.deepEqual(await f.page.evaluate(() => window.__opened), [], 'the system app was not asked');

    await ref.click();
    await f.view.getByRole('button', { name: 'More file actions', exact: true }).waitFor();
    await ref.click({ button: 'right' });
    await f.page.getByRole('menuitem', { name: 'Open in default app', exact: true }).click();
    assert.deepEqual(await f.page.evaluate(() => window.__opened), [`${CWD}/src/lib/parser.ts:2`]);
    assert.equal(await f.view.getByRole('button', { name: 'Open in default app', exact: true }).count(), 0);
    await ref.click({ button: 'right' });
    await f.page.getByRole('menuitem', { name: 'Open in Zed', exact: true }).click();
    await ref.click({ button: 'right' });
    await f.page.getByRole('menuitem', { name: 'Show in folder', exact: true }).click();
    assert.equal(await f.page.evaluate(() => window.__folder), `${CWD}/src/lib`);
    await ref.click({ button: 'right' });
    await f.page.getByRole('menuitem', { name: 'Copy relative path', exact: true }).click();
    assert.equal(await f.copied(), 'src/lib/parser.ts');
    await ref.click({ button: 'right' });
    await f.page.getByRole('menuitem', { name: 'Copy absolute path', exact: true }).click();
    assert.equal(await f.copied(), `${CWD}/src/lib/parser.ts`);

    // External editors are secondary actions in the file menu, including after a reload.
    await f.view.getByRole('button', { name: 'More file actions', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Open in gedit', exact: true }).click();
    assert.deepEqual((await f.page.evaluate(() => window.__edited)).at(-1), { target: `${CWD}/src/lib/parser.ts`, editor: 'gedit', line: 2 });
    await f.page.reload();
    await prepare(f.page, [{ id: 'zed', name: 'Zed' }, { id: 'gedit', name: 'gedit' }]);
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await f.ref('src/lib/parser.ts:2-3').click();
    assert.equal(await f.view.getByRole('button', { name: 'Open in gedit', exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('with no editor chosen, or none installed, Open in uses the system\'s default app; a file in the tree has the same menu', async () => {
  const f = await open();
  try {
    await f.ref('the lexer').click();
    await f.view.getByRole('button', { name: 'More file actions', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Open in default app', exact: true }).click();
    assert.deepEqual(await f.page.evaluate(() => window.__opened), [`${CWD}/src/lib/lexer.ts:1`]);
    await f.row('lexer.ts').click({ button: 'right' });
    const items = await f.page.getByRole('menu').getByRole('menuitem').allInnerTexts();
    assert.deepEqual(items, ['Open in default app', 'Show in folder', 'Copy absolute path', 'Copy relative path', 'Copy filename', 'Change this…']);
    await f.page.keyboard.press('Escape');
    await f.ref('/etc/hosts.conf:3').click({ button: 'right' });
    assert.deepEqual(await f.page.getByRole('menu').getByRole('menuitem').allInnerTexts(), ['Open in Files pane', 'Open in default app', 'Show in folder', 'Copy absolute path', 'Copy filename', 'Change this…'], 'outside the project: Files is available, relative paths are not');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('the tree can be hidden and shown with its button; a file too large or binary says so instead of showing, and an image shows as itself', async () => {
  await fs.mkdir(CWD, { recursive: true });
  const f = await open();
  try {
    await fs.writeFile(path.join(CWD, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
    await fs.writeFile(path.join(CWD, 'big.txt'), 'a'.repeat(600 * 1024));
    await fs.writeFile(path.join(CWD, 'shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP4z8DAwMDAxMDAwAAAHQAHAS/1UvQAAAAASUVORK5CYII=', 'base64'));
    await openFilesTab(f);
    await f.side.getByRole('button', { name: 'Refresh files', exact: true }).click();
    await f.row('blob.bin').click();
    await f.view.getByText('This is a binary file, so it is not shown here.').waitFor();
    await f.row('big.txt').click();
    await f.view.getByText(/over 512 KB, too large to show here/).waitFor();
    await f.row('shot.png').click();
    const picture = f.view.getByRole('img', { name: 'shot.png', exact: true });
    await picture.waitFor();
    await eventually(async () => assert.equal(await picture.evaluate(image => image.complete && image.naturalWidth), 2, 'an image file is shown as the picture it is'));
    await f.side.getByRole('button', { name: 'Hide file tree', exact: true }).click();
    assert.equal(await f.tree.count(), 0);
    await f.side.getByRole('button', { name: 'Show file tree', exact: true }).click();
    await f.tree.waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Ctrl+Shift+E shows the Files tab and, pressed again on it, closes the panel; Ctrl+Shift+F is still the full view', async () => {
  const f = await open();
  try {
    await f.page.keyboard.press('Control+Shift+E');
    await f.tree.waitFor();
    assert.equal(await f.side.getByRole('tab', { name: 'Files', exact: true }).getAttribute('aria-selected'), 'true');
    await f.page.keyboard.press('Control+Shift+E');
    await f.side.waitFor({ state: 'detached' });
    await f.page.keyboard.press('Control+Shift+E');
    await f.tree.waitFor();
    await f.page.keyboard.press('Control+Shift+F');
    await f.side.and(f.page.locator('.full')).waitFor();
    assert.equal(await f.tree.count(), 1, 'the full view keeps the tab');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('light and dark: the pane has only approved amber/orange accents in light, and nothing is cut off in either theme', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const f = await open({ colorScheme });
    try {
      await f.ref('src/lib/parser.ts:2-3').click();
      await f.editor('src/lib/parser.ts').waitFor();
      if (colorScheme === 'light') assert.deepEqual(await unapprovedOranges(f.page), [], 'light theme, Files tab: only approved amber/orange accents');
      const cut = await f.side.locator('.files-pane *').evaluateAll(nodes => nodes.filter(node => {
        if (!node.matches('.task-tab > button, [role="treeitem"], .file-view-path, .files-find input, .file-view-head button')) return false;
        const box = node.getBoundingClientRect(), parent = node.closest('.files-pane').getBoundingClientRect();
        return box.width > 0 && (box.right > parent.right + 1 || box.left < parent.left - 1);
      }).map(node => node.className || node.tagName));
      assert.deepEqual(cut, [], `${colorScheme}: nothing sticks out of the pane`);
      const heights = await f.side.locator('.fe-line').evaluateAll(lines => lines.map(line => Math.round(line.getBoundingClientRect().height)));
      const numberHeights = await f.side.locator('.fe-gutter-line').evaluateAll(lines => lines.map(line => Math.round(line.getBoundingClientRect().height)));
      assert.deepEqual(numberHeights, heights, 'each number is as tall as its line, wrapped or not, so the numbers line up');
      const gutter = await f.side.locator('.fe-gutter-line').evaluateAll(lines => lines.slice(0, 5).map(line => Math.round(line.getBoundingClientRect().top)));
      const text = await f.side.locator('.fe-line').evaluateAll(lines => lines.slice(0, 5).map(line => Math.round(line.getBoundingClientRect().top)));
      assert.deepEqual(gutter, text, 'each number sits on its line');
      await f.shot(`files-pane-${colorScheme}`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
