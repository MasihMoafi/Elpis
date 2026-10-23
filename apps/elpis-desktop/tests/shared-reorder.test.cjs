const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { compare, feedback } = require('./shared-reorder-check.cjs');
const { drag } = require('./settings-reorder-check.cjs');

const projects = ['First', 'Middle', 'Last'].map(name => ({ id: name, name, cwd: `/tmp/a70-${name}` }));
const projectStorage = { 'elpis-projects-v1': JSON.stringify({ projects, selectedId: null }) };
async function eventually(check) {
  const until = Date.now() + 5000;
  for (;;) { try { return await check(); } catch (error) {
    if (Date.now() >= until) throw error;
    await new Promise(resolve => setTimeout(resolve, 25));
  } }
}

test('ReorderItem preserves agent indentation when a context menu supplies its own inline style', () => {
  const { transpileModule, ModuleKind, JsxEmit } = require('typescript');
  const React = require('react');
  const source = readFileSync(path.join(__dirname, '../components/reorder.tsx'), 'utf8');
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  const component = { exports: {} };
  new Function('require', 'module', 'exports', code)(require, component, component.exports);
  for (const enabled of [false, true]) for (const depth of [0, 1, 2]) {
    const row = component.exports.ReorderItem({
      enabled, itemId: 'agent', reorder: { itemProps: () => ({ draggable: true }) },
      render: React.createElement('div', { style: { paddingLeft: `${depth * 14}px` } }),
      style: { userSelect: 'none' }, children: 'Agent title',
    });
    assert.equal(row.props.style.paddingLeft, `${depth * 14}px`, 'the nested row keeps its depth');
    assert.equal(row.props.style.userSelect, 'none', 'the menu retains its own interaction style');
    assert.equal(row.props.children, 'Agent title');
    assert.equal(row.props.draggable, enabled ? true : undefined);
  }
});

for (const theme of ['light', 'dark']) test(`A70/R29: chats, the sidebar and projects share one solid drag, motion, drop line and native events (${theme})`, async () => {
  const f = await fixture({ height: 1100, storage: { 'elpis-theme': theme, ...projectStorage } });
  try {
    await compare(f.page, { shots: process.env.ELPIS_A70_SHOTS && path.join(process.env.ELPIS_A70_SHOTS, theme) });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A70/R29: project rows use chat drag and keyboard order, cancel, save failures and reload', async () => {
  const f = await fixture({ height: 1100, storage: projectStorage });
  const rows = f.page.locator('aside.sidebar .project-row');
  const names = () => rows.locator('.sidebar-group-name').allTextContents();
  const row = name => rows.filter({ has: f.page.getByRole('button', { name, exact: true }) });
  try {
    for (const [id, target, after, expected] of [
      ['First', 'Last', true, ['Middle', 'Last', 'First']],
      ['Last', 'Middle', false, ['Last', 'Middle', 'First']],
      ['First', 'Last', true, ['Last', 'First', 'Middle']],
    ]) {
      await drag(f.page, row(id), row(target), after);
      await eventually(async () => assert.deepEqual(await names(), expected));
    }
    await drag(f.page, row('Middle'), row('Last'), false, true);
    assert.deepEqual(await names(), ['Last', 'First', 'Middle'], 'Escape cancels project movement');
    await row('First').locator('.project-toggle').focus();
    await f.page.keyboard.press('Alt+ArrowUp');
    await eventually(async () => assert.deepEqual(await names(), ['First', 'Last', 'Middle']));
    await eventually(async () => assert.equal(await row('First').locator('.project-toggle').evaluate(element => element === document.activeElement), true));
    await f.page.keyboard.press('Alt+ArrowUp');
    assert.deepEqual(await names(), ['First', 'Last', 'Middle'], 'first boundary stays in place');
    await f.page.reload(); await rows.first().waitFor();
    assert.deepEqual(await names(), ['First', 'Last', 'Middle'], 'native project order survives reload');
    await f.page.evaluate(() => { window.elpisDesktop.storage.saveItem = async () => { throw Error('A70 project disk unavailable'); }; });
    await row('First').locator('.project-toggle').focus(); await f.page.keyboard.press('Alt+ArrowDown');
    await f.page.getByRole('alert').filter({ hasText: 'A70 project disk unavailable' }).waitFor();
    assert.deepEqual(await names(), ['First', 'Last', 'Middle'], 'rejected project save retains order');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A70/R29: chats inside Projects share chat feedback, keyboard boundaries and saved membership', async () => {
  const f = await fixture({ height: 1100, storage: { ...projectStorage,
    'elpis-project-chats-v1': JSON.stringify({ 'chat-b': 'First', 'chat-c': 'First' }) } });
  try {
    const group = f.page.getByRole('group', { name: 'First', exact: true });
    const row = id => group.locator(`.thread-row[data-thread-id="${id}"]`);
    const ids = () => group.locator('.thread-row').evaluateAll(rows => rows.map(row => row.dataset.threadId));
    await feedback(f.page, row('chat-c'), row('chat-b'), { name: 'project-chat' });
    await eventually(async () => assert.deepEqual(await ids(), ['chat-c', 'chat-b']));
    await row('chat-b').locator('.thread-link').focus(); await f.page.keyboard.press('Alt+ArrowUp');
    await eventually(async () => assert.deepEqual(await ids(), ['chat-b', 'chat-c']));
    await f.page.keyboard.press('Alt+ArrowUp');
    assert.deepEqual(await ids(), ['chat-b', 'chat-c'], 'keyboard cannot move a chat out of its project');
    await f.page.reload(); await row('chat-b').waitFor();
    assert.deepEqual(await ids(), ['chat-b', 'chat-c']);
    assert.deepEqual(await f.page.evaluate(() => JSON.parse(localStorage.getItem('elpis-project-chats-v1'))), { 'chat-b': 'First', 'chat-c': 'First' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A70/R29: a refused chat save retains its order', async () => {
  const f = await fixture({ height: 1100 });
  try {
    const rows = f.page.locator('aside.sidebar section[aria-label="Recents"] .thread-row');
    const ids = () => rows.evaluateAll(elements => elements.map(element => element.dataset.threadId));
    const original = await ids();
    await f.page.evaluate(() => { window.elpisDesktop.storage.setItem = () => { throw Error('A70 chat disk unavailable'); }; });
    await rows.last().locator('.thread-link').focus(); await f.page.keyboard.press('Alt+ArrowUp');
    await f.page.getByRole('alert').filter({ hasText: 'Could not save chat groups on this device.' }).waitFor();
    assert.deepEqual(await ids(), original, 'failed chat save leaves the rendered order unchanged');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
