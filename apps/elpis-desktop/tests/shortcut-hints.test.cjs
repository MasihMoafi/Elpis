// Commands show their keys beside their names, as the ChatGPT app does, and follow Settings → Keyboard shortcuts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cjs');
const chat = { id: 'chat-a', name: 'Alpha', cwd: CWD, source: 'cli', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } };
const prefs = bindings => ({ 'elpis-preferences-v1': JSON.stringify({ shortcutBindings: JSON.stringify(bindings) }) });
const shown = (page, selector) => page.locator(selector).evaluate(element => getComputedStyle(element, '::after').content);

test('command labels and navigation titles follow default, rebound and disabled shortcuts', async () => {
  for (const [bindings, expected, navigation] of [
    [{}, '"Ctrl+N"', { sidebar: 'Ctrl+Shift+S', back: 'Alt+←', forward: 'Alt+→' }],
    [{ 'new-chat': 'Ctrl+Alt+M', sidebar: 'Ctrl+Alt+S', back: 'Ctrl+Alt+Left', forward: 'Ctrl+Alt+Right' }, '"Ctrl+Alt+M"', { sidebar: 'Ctrl+Alt+S', back: 'Ctrl+Alt+Left', forward: 'Ctrl+Alt+Right' }],
    [{ 'new-chat': '', sidebar: '', back: '', forward: '' }, 'none', { sidebar: '', back: '', forward: '' }],
  ]) {
    const f = await fixture({ threads: [chat], storage: prefs(bindings) });
    try {
      await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
      assert.equal(await shown(f.page, 'aside.sidebar .nav-list .new-chat'), expected);
      assert.equal(await f.page.getByRole('button', { name: 'New chat', exact: true }).count(), 1, 'the key is not part of its name');
      const title = (label, key) => key ? `${label} (${key})` : label;
      for (const [label, key] of [['Back', navigation.back], ['Forward', navigation.forward], ['Close sidebar', navigation.sidebar]]) {
        assert.equal(await f.page.getByRole('button', { name: label, exact: true }).getAttribute('title'), title(label, key));
      }
      await f.page.getByRole('button', { name: 'Close sidebar', exact: true }).click();
      const open = f.page.getByRole('button', { name: 'Open sidebar', exact: true });
      assert.equal(await open.getAttribute('title'), title('Open sidebar', navigation.sidebar));
      await open.click();
    } finally { await f.close(); }
  }
});

test('the chat menu shows the keys of Pin and Archive', async () => {
  const f = await fixture({ threads: [chat] });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.page.locator('aside.sidebar .thread-row[data-thread-id="chat-a"] .thread-link').click({ button: 'right' });
    const hint = name => f.page.getByRole('menuitem', { name, exact: true }).locator('.kbd-hint').textContent();
    assert.equal(await hint('Pin'), 'Ctrl+Alt+P');
    assert.equal(await hint('Archive'), 'Ctrl+Shift+A');
    assert.equal(await f.page.getByRole('menuitem', { name: 'New Session in New Window', exact: true }).count(), 0, 'a new session is not an action on this chat');
    await f.page.keyboard.press('Escape');
  } finally { await f.close(); }
});
