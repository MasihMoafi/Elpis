const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('the application menubar supports arrow keys and its File/Help actions open the working app surfaces', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const f = await fixture({ colorScheme });
    try {
      const bar = f.page.getByRole('menubar', { name: 'Application' });
      assert.deepEqual(await bar.getByRole('menuitem').allTextContents(), ['File', 'Edit', 'View', 'Help']);
      await bar.getByRole('menuitem', { name: 'File', exact: true }).focus();
      await f.page.keyboard.press('ArrowRight');
      assert.equal(await bar.getByRole('menuitem', { name: 'Edit', exact: true }).evaluate(element => element === document.activeElement), true);
      await f.page.keyboard.press('ArrowLeft'); await f.page.keyboard.press('ArrowDown');
      await f.page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
      await f.page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
      await bar.getByRole('menuitem', { name: 'Help', exact: true }).click();
      await f.page.getByRole('menuitem', { name: 'Keyboard shortcuts', exact: true }).click();
      await f.page.getByRole('alertdialog', { name: /keyboard shortcuts/i }).waitFor();
    } finally { await f.close(); }
  }
});

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
