const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const SOURCE = 'const long = "' + 'long_value '.repeat(55) + '";\nconst next = 2;\n';
const PATCH = '@@ -1,2 +1,2 @@\n-old\n+new\n next\n';
const WORK = [
  { id: 'edit', type: 'fileChange', status: 'completed', changes: [{ path: `${CWD}/src/app.ts`, kind: { type: 'add' }, diff: PATCH }] },
  { id: 'tool', type: 'mcpToolCall', server: 'local', tool: 'read_file', status: 'completed', arguments: { path: `${CWD}/src/app.ts:2` }, result: { content: [{ type: 'text', text: `Read ${CWD}/src/app.ts:2` }] } },
];
const outside = '/tmp/code-open-outside/worker.py';
const reply = `Inside: [app](src/app.ts#L2). Outside: [worker](${outside}#L2). Missing: [missing](/tmp/code-open-outside/missing.py). Web: [site](https://example.invalid/guide).`;
async function open(options = {}) {
  const f = await fixture({ width: 1280, height: 800, chat: [['t1', 'Show code', reply, WORK]], routes: {
    '/api/file': (_body, url) => url.searchParams.get('path').includes('missing') ? { __http: 404, error: 'This file is unavailable.' } : { content: SOURCE, size: SOURCE.length, mtimeMs: 1 },
    '/api/files/dir': () => ({ data: [{ name: 'src', dir: true }, { name: 'app.ts', dir: false }] }),
    '/api/customize': () => ({ skills: { data: [{ id: 'worker', name: 'Worker skill', description: 'Read its instructions', path: outside, scope: 'user', enabled: true, plugin: null }] }, plugins: { data: [] }, connectors: { data: [] } }),
    '/api/threads/chat-a/git': () => ({ root: CWD, files: [{ path: 'src/app.ts', status: 'modified', added: 1, removed: 1, binary: false }], diff: PATCH }),
  }, ...options });
  await f.page.evaluate(() => {
    window.__externalFiles = [];
    window.elpisDesktop.openFile = async file => { window.__externalFiles.push(file); };
    window.elpisDesktop.openExternalFile = async file => { window.__externalFiles.push(file); };
    window.elpisDesktop.editors = async () => [{ id: 'zed', name: 'Zed' }];
    window.elpisDesktop.openInEditor = async file => { window.__externalFiles.push(file); };
  });
  await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
  await f.page.locator('.message.agent').first().waitFor();
  return f;
}
const editor = (page, file) => page.getByRole('textbox', { name: `Contents of ${file}`, exact: true });

test('outside reply refs open internally at their line by Enter; missing files show an error and web links stay links', async () => {
  const f = await open();
  try {
    await f.page.getByRole('button', { name: 'worker', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await editor(f.page, outside).waitFor();
    assert.equal(await f.page.locator('.fe-line.hit').innerText(), 'const next = 2;');
    assert.deepEqual(await f.page.evaluate(() => window.__externalFiles), []);
    assert.equal(await f.page.getByRole('link', { name: 'site', exact: true }).getAttribute('href'), 'https://example.invalid/guide');
    await f.page.getByRole('button', { name: 'missing', exact: true }).click();
    await f.page.getByRole('region', { name: 'File viewer' }).getByRole('alert').waitFor();
    assert.deepEqual(await f.page.evaluate(() => window.__externalFiles), []);
  } finally { await f.close(); }
});

test('created file Open uses Files; an external editor requires a menu choice', async () => {
  const f = await open();
  try {
    const card = f.page.getByRole('list', { name: 'Files created' });
    await card.getByRole('button', { name: 'Open app.ts', exact: true }).click();
    await editor(f.page, 'src/app.ts').waitFor();
    assert.deepEqual(await f.page.evaluate(() => window.__externalFiles), []);
    await f.page.getByRole('button', { name: 'More file actions', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Open in Zed', exact: true }).click();
    assert.deepEqual(await f.page.evaluate(() => window.__externalFiles), [`${CWD}/src/app.ts`]);
  } finally { await f.close(); }
});

test('edit card file names and added diff line numbers open Files at the changed line', async () => {
  const f = await open();
  try {
    await f.page.locator('.worked-for > summary').click();
    await f.page.locator('.activity-group > summary').first().click();
    const file = f.page.locator('.step-file').first();
    await file.click();
    await editor(f.page, 'src/app.ts').waitFor();
    await f.page.getByRole('button', { name: 'Close side panel' }).click();
    const step = f.page.locator('details.step').filter({ has: file });
    await step.locator('summary').click();
    await step.getByRole('button', { name: 'Open line 1', exact: true }).click();
    await editor(f.page, 'src/app.ts').waitFor();
    assert.equal(await f.page.locator('.fe-line.hit').count(), 1);
  } finally { await f.close(); }
});

test('tool output file references are keyboard actionable', async () => {
  const f = await open();
  try {
    await f.page.locator('.worked-for > summary').click();
    await f.page.locator('.activity-group > summary').last().click();
    await f.page.locator('details.step').filter({ hasText: 'read_file' }).locator('summary').first().click();
    const ref = f.page.locator('.step-output').getByRole('button', { name: `${CWD}/src/app.ts:2`, exact: true });
    await ref.focus(); await f.page.keyboard.press('Enter');
    await editor(f.page, 'src/app.ts').waitFor();
    assert.equal(await f.page.locator('.fe-line.hit').innerText(), 'const next = 2;');
  } finally { await f.close(); }
});

test('Ledger skill names open their source in Files by keyboard', async () => {
  const f = await open();
  try {
    await f.page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
    await f.page.getByRole('button', { name: 'Worker skill', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await editor(f.page, outside).waitFor();
    assert.deepEqual(await f.page.evaluate(() => window.__externalFiles), []);
  } finally { await f.close(); }
});

test('Changes file paths open Files; the separate diff control retains diff browsing', async () => {
  const f = await open();
  try {
    await f.page.getByRole('button', { name: 'View changes', exact: true }).click();
    await f.page.getByRole('list', { name: 'Changed files' }).getByRole('button', { name: 'src/app.ts', exact: true }).click();
    await editor(f.page, 'src/app.ts').waitFor();
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) for (const width of [1280, 900]) test(`code scrolls horizontally; optional wrap aligns numbers and survives reload (${colorScheme}, ${width})`, async () => {
  const f = await open({ colorScheme, width });
  try {
    await f.page.getByRole('button', { name: 'app', exact: true }).click();
    const text = editor(f.page, 'src/app.ts'); await text.waitFor();
    assert.equal(await text.evaluate(el => getComputedStyle(el).whiteSpace), 'pre');
    assert.ok(await text.evaluate(el => el.scrollWidth > el.clientWidth + 300));
    await text.click(); await f.page.keyboard.press('Control+Home'); await f.page.keyboard.press('End');
    assert.ok(await text.evaluate(el => el.scrollLeft > 0), 'End reveals the long line');
    assert.equal(await f.page.locator('.fe-gutter-line').nth(1).evaluate(el => el.getBoundingClientRect().height), 20);
    // Scrollable code is intentionally checked separately: ui-fit treats any textarea with vertical scroll as clipped.
    await assertUiFit(f.page.locator('.files-bar'), 'file tabs fit');
    await assertUiFit(f.page.locator('.file-view-head'), 'file header fits');
    await f.page.keyboard.press('Control+Home');
    if (process.env.ELPIS_SHOTS) { await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await f.page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `code-nowrap-${colorScheme}-${width}.png`) }); }
    await f.page.getByRole('button', { name: 'More file actions', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Enable soft wrap', exact: true }).click();
    assert.equal(await text.getAttribute('wrap'), 'soft');
    await f.page.waitForFunction(() => document.querySelector('.fe-gutter-line')?.getBoundingClientRect().height > 20);
    const [gutter, line] = await Promise.all([f.page.locator('.fe-gutter-line').first().boundingBox(), f.page.locator('.fe-line').first().boundingBox()]);
    assert.equal(gutter.height, line.height, 'number rows match wrapped source rows');
    assert.ok(line.x >= gutter.x + gutter.width, 'continuations stay beyond the gutter');
    if (process.env.ELPIS_SHOTS) { await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true }); await f.page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `code-open-${colorScheme}-${width}.png`) }); }
    await f.page.reload(); await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
  await f.page.locator('.message.agent').first().waitFor();
    await f.page.getByRole('button', { name: 'app', exact: true }).click();
    assert.equal(await editor(f.page, 'src/app.ts').getAttribute('wrap'), 'soft');
  } finally { await f.close(); }
});

test('a tool argument explicitly naming a bare filename opens that file in Files', async () => {
  const work = [{ ...WORK[1], arguments: { path: 'config.toml', model: 'gpt-6.1', url: 'https://example.invalid/a.py' } }];
  const f = await open({ chat: [['t1', 'Read the config', 'Read it.', work]] });
  try {
    await f.page.locator('.worked-for > summary').click();
    await f.page.locator('.activity-group > summary').click();
    await f.page.locator('details.step > summary').click();
    await f.page.locator('.step-input > summary').click();
    assert.deepEqual(await f.page.locator('.step-input').getByRole('button').allInnerTexts(), ['config.toml'], 'model names and web URLs stay text');
    await f.page.locator('.step-input').getByRole('button', { name: 'config.toml', exact: true }).click();
    await editor(f.page, 'config.toml').waitFor();
    assert.deepEqual(await f.page.evaluate(() => window.__externalFiles), []);
  } finally { await f.close(); }
});
