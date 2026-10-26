// Rule R12 on every page (Masih, 20 Oct: "the buttons must be navigable via arrow keys; they aren't in settings page").
// For every visible, enabled button or link on the chat, every Settings section and Workflows, an arrow key must move
// focus to another control in the same area (its dialog, region, nav, aside, main, header, footer, form or labelled
// section; a tab list or radio group inside that area counts as inside it), whenever that area holds another control. This test does not reuse lib/arrow-keys.ts: it presses the real
// keys and reads where focus went. Menu buttons open their menu with the arrows and are left out; a closed drop-down
// list is an ordinary button here, which Enter or Space opens (Masih, 20 Oct: arrowing through Settings › General
// stopped at Speed). Text fields, the board, the drawing, editors and terminals keep their own keys.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { leaveSettings, openSettings } = require('./controls.cjs');

const HELPERS = `
  window.__arrows = (() => {
    const CONTROL = 'button, a[href], summary, [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="treeitem"], [role="radio"]:not(input), [role="checkbox"]:not(input)';
    const SKIP = '.xterm, .excalidraw, .react-flow, .cm-editor, [data-arrows="off"], [aria-haspopup]:not([aria-haspopup="listbox"]), [role="combobox"]:not([aria-haspopup="listbox"]), [role="slider"]';
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
      stalled(index) {
        const el = document.querySelector('[data-arrow-check="' + index + '"]'), active = document.activeElement;
        if (!el) return { missing: true, active: active && name(active) };
        const ancestors = [];
        for (let at = el.parentElement; at; at = at.parentElement) {
          ancestors.push({ tag: at.tagName, controls: [...at.querySelectorAll(CONTROL)].map(control => ({ name: name(control), usable: usable(control), disabled: control.disabled === true, rects: control.getClientRects().length })) });
          if (at === area(el)) break;
        }
        return { control: name(el), active: active && name(active), activeTag: active?.tagName, area: area(el).getAttribute('aria-label') || area(el).tagName,
          ancestors };
      },
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
    if (!(await page.evaluate(i => window.__arrows.moved(i), index))) {
      stuck.push(`${where}: “${label}”`);
      console.log(`${where} arrow focus: ${JSON.stringify(await page.evaluate(i => window.__arrows.stalled(i), index))}`);
    }
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

test('a closed drop-down passes the arrow keys on; Enter and Space open it', { timeout: 60000 }, async () => {
  const f = await fixture({ desktop: true });
  try {
    await f.open('chat-a');
    await openSettings(f.page);
    await f.page.getByRole('tablist', { name: 'Settings sections' }).getByRole('tab', { name: 'General', exact: true }).click();
    const send = f.page.getByRole('combobox', { name: 'Send shortcut', exact: true }), list = f.page.getByRole('listbox');
    for (const key of ['ArrowDown', 'ArrowUp']) {
      await send.focus();
      await f.page.keyboard.press(key);
      // Send shortcut is first in its group, so Up stays put there (at an end nothing moves); neither key opens it.
      if (key === 'ArrowDown') assert.equal(await send.evaluate(el => el === document.activeElement), false, 'ArrowDown leaves Send shortcut');
      assert.equal(await list.count(), 0, `${key} does not open Send shortcut`);
    }
    for (const key of ['Enter', ' ']) {
      await send.focus();
      await f.page.keyboard.press(key);
      await list.waitFor({ timeout: 3000 });
      await f.page.keyboard.press('Escape');
      await list.waitFor({ state: 'detached', timeout: 3000 });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('pending sidebar navigation stops when focus leaves its control and activates when focus stays', async () => {
  const f = await fixture({ desktop: true });
  try {
    const { page } = f;
    await f.open('chat-a');
    const nav = page.locator('aside.sidebar nav[aria-label="Workspace"]');
    const workflows = nav.getByRole('button', { name: 'Workflows', exact: true });
    const loveSpot = nav.getByRole('button', { name: 'Love Spot', exact: true });
    await workflows.click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    const sources = canvas.getByRole('link', { name: 'Sources for Debate + judge', exact: true });
    await sources.waitFor();
    const time = new Date();
    await page.clock.install({ time }); await page.clock.pauseAt(time);

    await workflows.focus(); await page.keyboard.press('ArrowDown');
    assert.equal(await loveSpot.evaluate(element => element === document.activeElement), true);
    await page.clock.runFor(149);
    assert.equal(await canvas.isVisible(), true, 'the debounce does not navigate early');
    await sources.focus();
    await page.clock.runFor(1);
    assert.equal(await canvas.isVisible(), true, 'a stale sidebar schedule cannot replace the focused page');
    assert.equal(await sources.evaluate(element => element === document.activeElement), true, 'focus remains on the connected workflow control');

    await workflows.focus(); await page.keyboard.press('ArrowDown');
    await page.clock.runFor(149);
    await sources.focus(); await loveSpot.focus();
    await page.clock.runFor(1);
    assert.equal(await canvas.isVisible(), true, 'returning to the old destination does not revive a cancelled schedule');

    await workflows.focus(); await page.keyboard.press('ArrowDown');
    await page.clock.runFor(149);
    assert.equal(await canvas.isVisible(), true);
    await page.clock.runFor(1);
    await page.getByRole('heading', { name: 'Love Spot', exact: true }).waitFor();
    assert.equal(await loveSpot.evaluate(element => element === document.activeElement), true, 'held focus still opens its destination without Enter');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
