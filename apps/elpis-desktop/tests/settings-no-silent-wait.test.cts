// Settings spec (specs/settings.md) S5 and S6, 10 Nov: a page never waits silently, and a control that is off says why.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');
const { openSettings } = require('./controls.cts');

test('Import chats says what it reads while the bridge is slow, then shows the counts or one error (S5)', async () => {
  let release: () => void = () => {};
  const slow = new Promise<void>(resolve => { release = resolve; });
  const listing = { days: 30, atATime: 20, sources: [{ id: 'claude', name: 'Claude Code', chats: 3 }] };
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, routes: { '/api/import-chats': async () => { await slow; return listing; } } }), { page } = f;
  try {
    await f.open('chat-a');
    await openSettings(page);
    await page.getByRole('tab', { name: 'Import chats', exact: true }).click();
    const reading = page.getByText('Reading your Claude Code and Codex chats…', { exact: true });
    await reading.waitFor({ timeout: 300 + 1000 });
    release();
    await page.getByText('3 chats from the last 30 days.', { exact: true }).waitFor();
    assert.equal(await reading.count(), 0, 'the reading line goes once the counts arrive');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Import chats with nothing to import says so instead of an empty page (S5, negative case)', async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, routes: { '/api/import-chats': () => ({ days: 30, atATime: 20, sources: [] }) } }), { page } = f;
  try {
    await f.open('chat-a');
    await openSettings(page);
    await page.getByRole('tab', { name: 'Import chats', exact: true }).click();
    await page.getByText('No chats to import', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('on every Settings page, a row whose control is off tells why (S6)', async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1280, height: 900 }), { page } = f;
  try {
    await f.open('chat-a');
    await openSettings(page);
    const tabs = page.locator('.settings-nav [role="tab"]');
    const names: string[] = await tabs.evaluateAll((all: Element[]) => all.map(tab => (tab.textContent ?? '').trim()));
    const silent: string[] = [];
    for (const [index, name] of names.entries()) {
      await tabs.nth(index).click();
      await page.waitForTimeout(400);
      silent.push(...await page.locator('.settings-page').evaluate((root: HTMLElement, tab: string) =>
        [...root.querySelectorAll<HTMLElement>('[data-slot="settings-row"]')]
          .filter(row => row.offsetParent && !row.closest('[hidden]'))
          .filter(row => {
            const controls = [...row.querySelectorAll<HTMLElement>('.settings-row-control :is(button, input, select, textarea, [role="switch"], [role="combobox"])')];
            // A save button waits for changes, which is its own reason; any other control that is off must be explained.
            const off = controls.filter(control => (control as HTMLButtonElement).disabled && !/^Save\b/.test(control.textContent ?? ''));
            return off.length > 0 && controls.length === off.length && !(row.querySelector('.settings-row-description')?.textContent ?? '').trim();
          })
          .map(row => `${tab} › ${(row.querySelector('.settings-row-text')?.textContent ?? '').trim().slice(0, 50)}`), name));
    }
    assert.deepEqual(silent, []);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
