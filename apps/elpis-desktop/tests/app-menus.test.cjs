const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('Edit restores the text field and selection before requesting native Paste', async () => {
  const f = await fixture();
  try {
    await f.page.addInitScript(() => {
      window.__menuCalls = [];
      window.elpisDesktop.menu = { command: async command => { const element = document.activeElement; window.__menuCalls.push({ command, label: element.getAttribute('aria-label'), start: element.selectionStart, end: element.selectionEnd }); }, subscribe: () => () => {} };
    });
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    const input = f.page.getByLabel('Message Elpis', { exact: true }); await input.fill('selected text');
    await input.evaluate(element => { element.focus(); element.setSelectionRange(0, 8); });
    await f.page.getByRole('menubar', { name: 'Application' }).getByRole('menuitem', { name: 'Edit', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Paste', exact: true }).click();
    await f.page.waitForFunction(() => window.__menuCalls.length === 1);
    assert.deepEqual(await f.page.evaluate(() => window.__menuCalls), [{ command: 'paste', label: 'Message Elpis', start: 0, end: 8 }]);
  } finally { await f.close(); }
});
