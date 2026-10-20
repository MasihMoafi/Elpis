// Rule R12 on every page (Masih, 20 Oct: "the buttons must be navigable via arrow keys; they aren't in settings page").
// For every visible, enabled button or link on the chat, every Settings section and Workflows, an arrow key must move
// focus to another control in the same area (its dialog, region, nav, aside, main, header, footer, form or labelled
// section; a tab list or radio group inside that area counts as inside it), whenever that area holds another control. This test does not reuse lib/arrow-keys.ts: it presses the real
// keys and reads where focus went. Menu buttons open their menu with the arrows and are left out; text fields, the
// board, the drawing, editors and terminals keep their own keys.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { leaveSettings, openSettings } = require('./controls.cjs');

const HELPERS = `
  window.__arrows = (() => {
    const CONTROL = 'button, a[href], summary, [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="treeitem"], [role="radio"]:not(input), [role="checkbox"]:not(input)';
    const SKIP = '.xterm, .excalidraw, .react-flow, .cm-editor, [data-arrows="off"], [aria-haspopup], [role="combobox"], [role="slider"]';
    const AREA = 'dialog, [role="dialog"], [role="alertdialog"], [role="region"], [role="menu"], [role="listbox"], [role="toolbar"], [role="tablist"], [role="radiogroup"], [role="tree"], nav, aside, main, header, footer, form, section[aria-label]';
    const usable = el => el instanceof HTMLElement && !el.closest('.xterm, .excalidraw, .react-flow, .cm-editor, [data-arrows="off"], [inert], [hidden], [aria-hidden="true"]')
      && !el.disabled && el.getAttribute('aria-disabled') !== 'true' && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const area = el => el.parentElement?.closest(AREA) ?? document.body;
    const name = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 60);
    return {
      mark() {
        document.querySelectorAll('[data-arrow-check]').forEach(el => el.removeAttribute('data-arrow-check'));
        const all = [...document.querySelectorAll(CONTROL)].filter(usable);
        const checked = all.filter(el => !el.matches(SKIP) && all.some(other => other !== el && area(other) === area(el)));
        checked.forEach((el, index) => el.setAttribute('data-arrow-check', String(index)));
        return checked.length;
      },
      focus(index) { const el = document.querySelector('[data-arrow-check="' + index + '"]'); if (!el || !usable(el)) return null; el.focus(); return document.activeElement === el ? name(el) : null; },
      moved(index) { const el = document.querySelector('[data-arrow-check="' + index + '"]'), now = document.activeElement; return !!el && now !== el && now instanceof HTMLElement && now.matches(CONTROL) && area(el).contains(now); },
    };
  })();`;

/** Every checked control on the page as it is now; returns the ones no arrow key moved away from. */
async function sweep(page, where) {
  await page.evaluate(HELPERS);
  const count = await page.evaluate(() => window.__arrows.mark());
  const stuck = [];
  for (let index = 0; index < count; index++) {
    let label = await page.evaluate(i => window.__arrows.focus(i), index);
    if (!label) continue;
    await page.keyboard.press('ArrowDown');
    if (await page.evaluate(i => window.__arrows.moved(i), index)) continue;
    label = await page.evaluate(i => window.__arrows.focus(i), index);
    if (!label) continue;
    await page.keyboard.press('ArrowUp');
    if (!(await page.evaluate(i => window.__arrows.moved(i), index))) stuck.push(`${where}: “${label}”`);
  }
  return { count, stuck };
}

test('arrow keys move between the buttons of every page: chat, each Settings section, Workflows', { timeout: 170000 }, async () => {
  const f = await fixture({ desktop: true });
  try {
    await f.open('chat-a');
    const results = [await sweep(f.page, 'chat')];
    await openSettings(f.page);
    const tabs = f.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab');
    for (const name of await tabs.allInnerTexts()) {
      await f.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: name.trim(), exact: true }).click();
      await f.page.waitForTimeout(150);
      results.push(await sweep(f.page, `Settings › ${name.trim()}`));
    }
    await leaveSettings(f.page);
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.page.getByRole('region', { name: 'Workflows', exact: true }).waitFor();
    results.push(await sweep(f.page, 'Workflows'));
    const checked = results.reduce((sum, result) => sum + result.count, 0), stuck = results.flatMap(result => result.stuck);
    console.log(`checked ${checked} controls; stuck ${stuck.length}`);
    assert.ok(checked > 100, `the sweep reached the pages (${checked} controls)`);
    assert.deepEqual(stuck, [], `${stuck.length} of ${checked} controls do not move with the arrow keys`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
