const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { chooseOption, controlValue } = require('./controls.cjs');

const model = { id: 'sol', model: 'sol', displayName: 'Sol', defaultReasoningEffort: 'medium', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })) };
const routes = { '/api/models': () => ({ data: [model], nextCursor: null }), '/api/settings': () => ({ background: {}, memory: {}, smartPrune: { explicitOverride: {} }, write: { available: false }, main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }] }) };

test('Shift+Up/Down steps reasoning effort from the model default, clamps at the ends, and preserves the draft', async () => {
  const f = await fixture({ routes }), { page } = f;
  try {
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    const effort = page.getByLabel('Reasoning effort', { exact: true });
    await effort.waitFor();
    await input.fill('Keep this draft\nمتن فارسی'); await input.focus();
    const step = async (key, expected) => { await input.press(key); assert.equal(await controlValue(effort), expected); assert.equal(await input.evaluate(node => node === document.activeElement), true); };
    await step('Shift+ArrowUp', 'high');
    await step('Shift+ArrowUp', 'xhigh'); await step('Shift+ArrowUp', 'xhigh');
    await step('Shift+ArrowDown', 'high'); await step('Shift+ArrowDown', 'medium');
    await step('Shift+ArrowDown', 'low'); await step('Shift+ArrowDown', 'low');
    assert.equal(await input.inputValue(), 'Keep this draft\nمتن فارسی');
    await step('Control+Shift+ArrowUp', 'low'); await step('Alt+Shift+ArrowUp', 'low');
    const search = page.getByRole('textbox', { name: 'Search conversations', exact: true });
    await search.fill('search text'); await search.press('Shift+ArrowUp');
    assert.equal(await controlValue(effort), 'low', 'selection outside the composer does not change effort');
    assert.equal(f.posts.filter(post => post.path.endsWith('/turns')).length, 0, 'shortcuts do not send a message');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('an effort picked in an existing chat is saved at once, survives a reload, and a refused save puts the old one back', async () => {
  const thread = { id: 'chat-a', name: 'Effort chat', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', reasoningEffort: 'medium', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  let refuse = false;
  const f = await fixture({ routes: { ...routes,
    '/api/threads': (_body, url) => ({ data: url.searchParams.has('ancestorThreadId') ? [] : [thread], nextCursor: null }),
    '/api/threads/chat-a': () => ({ thread, data: [], nextCursor: null }),
    '/api/threads/chat-a/resume': () => ({ thread, activeTurnId: null }),
    // As the bridge: the engine keeps the chat's effort.
    '/api/threads/chat-a/effort': body => refuse ? { __http: 409, error: 'Elpis refused that effort.' } : (thread.reasoningEffort = body.effort, { reasoningEffort: body.effort }),
  } }), { page } = f;
  const saved = () => f.posts.filter(post => post.path === '/api/threads/chat-a/effort').map(post => post.body.effort);
  const open = async () => { await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').first().click(); await page.getByLabel('Reasoning effort', { exact: true }).waitFor(); };
  try {
    await open();
    const effort = page.getByLabel('Reasoning effort', { exact: true });
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await chooseOption(effort, 'low');
    await input.fill('Use the selected effort'); await input.press('Shift+ArrowUp');
    assert.equal(await controlValue(effort), 'medium');
    await input.press('Shift+ArrowUp'); assert.equal(await controlValue(effort), 'high');
    for (let tries = 0; saved().length < 3 && tries < 50; tries++) await page.waitForTimeout(20);
    assert.deepEqual(saved(), ['low', 'medium', 'high'], 'menu and shortcut each save the pick at once');
    await page.reload(); await open();
    assert.equal(await controlValue(page.getByLabel('Reasoning effort', { exact: true })), 'high', 'the pick survives a restart');
    await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).fill('Go');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="Message Elpis"]')?.value === '');
    assert.equal('effort' in f.posts.find(post => post.path === '/api/threads/chat-a/turns').body, false, 'the chat already holds it');
    refuse = true;
    await chooseOption(page.getByLabel('Reasoning effort', { exact: true }), 'xhigh');
    await page.getByText('Elpis refused that effort.').waitFor();
    assert.equal(await controlValue(page.getByLabel('Reasoning effort', { exact: true })), 'high', 'a refused pick is not shown as saved');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Shift+Up/Down leaves models without reasoning levels alone', async () => {
  const f = await fixture({ routes: { ...routes, '/api/models': () => ({ data: [{ ...model, supportedReasoningEfforts: [] }], nextCursor: null }) } }), { page } = f;
  try {
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await input.fill('No reasoning levels'); await input.press('Shift+ArrowUp'); await input.press('Shift+ArrowDown');
    assert.equal(await input.inputValue(), 'No reasoning levels');
    assert.equal(await page.getByLabel('Reasoning effort', { exact: true }).count(), 0);
    assert.equal(f.posts.filter(post => /\/(turns|shell)$/.test(post.path)).length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('Shift+Up/Down in shell mode preserves the configured reasoning effort', async () => {
  const f = await fixture({ routes }), { page } = f;
  try {
    const effort = page.getByLabel('Reasoning effort', { exact: true });
    await chooseOption(effort, 'low');
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await input.focus(); await input.press('!'); await input.fill('printf hello');
    await input.press('Shift+ArrowUp'); await input.press('Shift+ArrowDown');
    assert.equal(await input.inputValue(), 'printf hello');
    await input.press('Escape'); assert.equal(await controlValue(effort), 'low');
    assert.equal(f.posts.filter(post => /\/(turns|shell)$/.test(post.path)).length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('Ctrl+A copies the focused chat content without navigation and keeps composer selection native', async () => {
  const f = await fixture(), { page } = f;
  try {
    const content = page.locator('.chat-content');
    await content.click({ position: { x: 12, y: 12 } });
    await page.keyboard.press('Control+a');
    const chosen = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    assert.ok(chosen.trim().length > 0);
    assert.ok(!(chosen.includes('New chat') || chosen.includes('Local workspace')), 'selecting the chat excludes app navigation');
    const input = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await input.fill('Only the unfinished message.'); await input.press('Control+a');
    assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [0, 28]);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
