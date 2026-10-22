// Commands show their keys beside their names, as the ChatGPT app does, and follow Settings → Keyboard shortcuts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');
const chat = { id: 'chat-a', name: 'Alpha', cwd: CWD, source: 'cli', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } };
const prefs = bindings => ({ 'elpis-preferences-v1': JSON.stringify({ shortcutBindings: JSON.stringify(bindings) }) });
const shown = (page, selector) => page.locator(selector).evaluate(element => getComputedStyle(element, '::after').content);

test('New chat shows Ctrl+N beside its name and the key chosen in Settings replaces it', async () => {
  for (const [bindings, expected] of [[{}, '"Ctrl+N"'], [{ 'new-chat': 'Ctrl+Alt+M' }, '"Ctrl+Alt+M"'], [{ 'new-chat': '' }, 'none']]) {
    const f = await fixture({ threads: [chat], storage: prefs(bindings) });
    try {
      await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
      assert.equal(await shown(f.page, 'aside.sidebar .nav-list .new-chat'), expected);
      assert.equal(await f.page.getByRole('button', { name: 'New chat', exact: true }).count(), 1, 'the key is not part of its name');
    } finally { await f.close(); }
  }
});

test('the chat menu and the account menu show the keys of Pin, Archive and Settings', async () => {
  const f = await fixture({ threads: [chat] });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.page.locator('aside.sidebar .thread-row[data-thread-id="chat-a"] .thread-link').click({ button: 'right' });
    const hint = name => f.page.getByRole('menuitem', { name, exact: true }).locator('.kbd-hint').textContent();
    assert.equal(await hint('Pin'), 'Ctrl+Alt+P');
    assert.equal(await hint('Archive'), 'Ctrl+Shift+A');
    await f.page.keyboard.press('Escape');
    await f.page.locator('aside.sidebar .account-row').click();
    assert.equal(await hint('Settings'), 'Ctrl+,');
  } finally { await f.close(); }
});
