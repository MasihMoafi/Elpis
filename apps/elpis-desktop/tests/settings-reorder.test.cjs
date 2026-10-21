// Built CI renderer + mock bridge: regression evidence only; real-app acceptance uses settings-reorder.runtime.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { check, drag } = require('./settings-reorder-check.cjs');
const { openSettings } = require('./controls.cjs');

for (const theme of ['light', 'dark']) test(`A70: Settings reorder, cancel, keyboard and reload (${theme})`, async () => {
  const f = await fixture({ height: 1080, storage: { 'elpis-theme': theme } });
  try {
    await check(f.page, { theme, shots: process.env.ELPIS_A70_SHOTS });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A70: failed storage leaves Settings order unchanged and explains the error', async () => {
  const f = await fixture({ height: 1080 });
  try {
    await openSettings(f.page);
    const sections = f.page.locator('.settings-nav [data-slot="section-link"]'), original = await sections.allTextContents();
    // Refuse exactly the same synchronous persistence boundary that a full browser store refuses.
    await f.page.evaluate(() => { window.elpisDesktop.storage.setItem = () => { throw Error('A70 disk unavailable'); }; });
    await sections.first().focus(); await f.page.keyboard.press('Alt+ArrowDown');
    await f.page.getByRole('alert').filter({ hasText: 'Could not save Settings order: A70 disk unavailable' }).waitFor();
    assert.deepEqual(await sections.allTextContents(), original);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A70: a pending reorder never takes focus back from the next control', async () => {
  const f = await fixture({ height: 1080 });
  try {
    await openSettings(f.page);
    await f.page.clock.install();
    await f.page.clock.pauseAt(Date.now() + 1000);
    const sections = f.page.locator('.settings-nav [data-slot="section-link"]');
    const moved = sections.first(), next = sections.nth(2);
    const nextName = await next.textContent();
    await moved.focus(); await f.page.keyboard.press('Alt+ArrowDown');
    const destination = sections.filter({ hasText: nextName });
    await destination.focus();
    await f.page.clock.runFor(32);
    assert.equal(await destination.evaluate(element => element === document.activeElement), true, 'the next control keeps focus after the reorder frame');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A70: a boundary key cannot steal focus from the next section or reorder it', async () => {
  const f = await fixture({ height: 1080 });
  try {
    await openSettings(f.page);
    const sections = f.page.locator('.settings-nav [data-slot="section-link"]'), original = await sections.allTextContents();
    // Both actions happen before the next animation frame, as they can under CI load.
    await sections.evaluateAll(rows => {
      rows[0].focus();
      rows[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
      rows.at(-1).focus();
    });
    await f.page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(await sections.last().evaluate(element => element === document.activeElement), true, 'boundary no-op keeps later focus');
    await f.page.keyboard.press('Alt+ArrowDown');
    assert.deepEqual(await sections.allTextContents(), original, 'both boundary moves leave the full order intact');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('A13/A70: the shared sidebar navigation still reorders by keyboard and drag', async () => {
  const f = await fixture({ height: 1080 });
  try {
    const rows = f.page.locator('aside.sidebar [data-nav-page]');
    const ids = () => rows.evaluateAll(elements => elements.map(element => element.dataset.navPage));
    const expected = await ids();
    await rows.first().focus(); await f.page.keyboard.press('Alt+ArrowDown');
    [expected[0], expected[1]] = [expected[1], expected[0]];
    assert.deepEqual(await ids(), expected);
    assert.equal(await rows.nth(1).evaluate(element => element === document.activeElement), true);
    await drag(f.page, rows.last(), rows.first());
    expected.unshift(expected.pop());
    assert.deepEqual(await ids(), expected);
    await f.page.reload(); await rows.first().waitFor();
    assert.deepEqual(await ids(), expected);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
