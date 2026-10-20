// Rule R5 on every page (Masih, 20 Oct: "I've told of the idea of uniformity; you've never implemented it"): the same
// kind of element shares one component, one colour and one shape. On the chat, every Settings section and Workflows,
// each visible button must come from a shared component (it carries data-slot), and all buttons of one kind (component,
// variant, size and state) must look the same: height (of a one-line control), corners, cut, background, text and edge
// colour, font. Pointer and
// focus are moved away first, so hover and focus never count as a look.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { leaveSettings, openSettings } = require('./controls.cjs');

/** Every visible button on the page now: its kind and its look. */
async function looks(page, where) {
  await page.mouse.move(1, 1);
  await page.waitForTimeout(200); // Observe settled button colors after a navigation transition.
  return page.evaluate(where => {
    (document.activeElement instanceof HTMLElement) && document.activeElement.blur();
    const SKIP = '.xterm, .excalidraw, .react-flow, .cm-editor, [inert], [hidden], [aria-hidden="true"]';
    const state = el => ['aria-pressed', 'aria-expanded', 'aria-selected', 'aria-current', 'data-active', 'data-state', 'aria-checked']
      .map(name => el.getAttribute(name)).filter(value => value && value !== 'false' && value !== 'closed' && value !== 'unchecked').join(',') + (el.disabled ? 'disabled' : '');
    const name = el => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return [...document.querySelectorAll('button, [role="button"]')].filter(el => el instanceof HTMLElement && !el.closest(SKIP) && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => {
      const css = getComputedStyle(el), box = el.getBoundingClientRect();
      const slot = el.dataset.slot ?? '';
      return {
        where, label: name(el), slot,
        kind: slot ? `${slot}:${el.dataset.variant ?? ''}/${el.dataset.size ?? ''}${state(el) ? ` [${state(el)}]` : ''}` : '',
        cls: typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean) : [],
        ctx: [el.parentElement, el.parentElement?.parentElement, el.parentElement?.parentElement?.parentElement].map(at => at && typeof at.className === 'string' ? at.className.split(/\s+/).filter(token => !/[:\[\]/()]/.test(token)).slice(0, 3).join('.') : '').filter(Boolean).join(' < '),
        // A card taller than any control (48px) is as tall as its text: its height is content, not look.
        look: [box.height > 48 ? 'content' : Math.round(box.height), css.borderRadius, css.clipPath === 'none' ? '' : 'cut', css.backgroundColor, css.color, `${css.borderTopWidth} ${css.borderTopColor}`, `${css.fontSize} ${css.fontWeight}`].join(' | '),
      };
    });
  }, where);
}

test('one role, one look: every button comes from a shared component, and each kind looks the same everywhere', { timeout: 170000 }, async () => {
  const f = await fixture({ desktop: true });
  try {
    await f.open('chat-a');
    const all = [...await looks(f.page, 'chat')];
    await openSettings(f.page);
    const tabs = f.page.getByRole('tablist', { name: 'Settings sections' });
    for (const name of await tabs.getByRole('tab').allInnerTexts()) {
      await tabs.getByRole('tab', { name: name.trim(), exact: true }).click(); await f.page.waitForTimeout(150);
      all.push(...await looks(f.page, `Settings › ${name.trim()}`));
    }
    await leaveSettings(f.page);
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.page.getByRole('region', { name: 'Workflows', exact: true }).waitFor();
    all.push(...await looks(f.page, 'Workflows'));
    const outside = [...new Set(all.filter(item => !item.slot).map(item => `${item.where}: “${item.label}”`))];
    const kinds = new Map();
    for (const item of all.filter(item => item.slot)) {
      const looks = kinds.get(item.kind) ?? new Map();
      looks.set(item.look, [...(looks.get(item.look) ?? []), item]);
      kinds.set(item.kind, looks);
    }
    // Each odd look names what its buttons add to the usual one of their kind: own classes, then the classes around them.
    const mixed = [...kinds].filter(([, looks]) => looks.size > 1).map(([kind, looks]) => {
      const usual = [...looks.values()].sort((a, b) => b.length - a.length)[0][0];
      return `${kind}\n${[...looks].map(([look, who]) => `    ${who.length}× ${look}  e.g. ${who[0].where}: “${who[0].label}”  adds [${who[0].cls.filter(token => !usual.cls.includes(token)).join(' ')}] in ${who[0].ctx}`).join('\n')}`;
    });
    console.log(`${all.length} buttons, ${kinds.size} kinds; ${outside.length} outside a shared component; ${mixed.length} kinds with more than one look`);
    if (outside.length || mixed.length) console.log(`OUTSIDE\n${outside.join('\n')}\nMIXED\n${mixed.join('\n')}`);
    assert.deepEqual(outside, [], 'buttons that are not a shared component');
    assert.deepEqual(mixed, [], 'kinds with more than one look');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('MCP API-key fields share the Settings field-to-save gap and controls stay apart', { timeout: 30000 }, async () => {
  const f = await fixture({ desktop: true, routes: {
    '/api/mcp': () => ({ version: 'm1', write: { available: true }, servers: [{
      name: 'fixture-server', enabled: true, transport: 'stdio', command: 'fixture-mcp', url: null,
      credentials: ['SERVICE_API_KEY', 'SERVICE_TOKEN'].map(name => ({ name, source: 'config', set: false })),
    }] }),
  } });
  try {
    await f.open('chat-a');
    await openSettings(f.page);
    await f.page.getByRole('tab', { name: 'MCP servers', exact: true }).click();
    const keyForm = f.page.getByRole('form', { name: 'API keys for fixture-server' });
    await keyForm.locator('input[type="password"]').first().waitFor();
    await f.page.getByRole('button', { name: 'Add MCP server' }).click();
    const addForm = f.page.getByRole('form', { name: 'Add MCP server' });
    const referenceGap = await addForm.evaluate(form => {
      const field = form.querySelector('textarea').getBoundingClientRect();
      const save = form.querySelector('button[type="submit"]').getBoundingClientRect();
      return save.top - field.bottom;
    });
    const boxes = await keyForm.locator('input[type="password"], button[type="submit"]').evaluateAll(controls =>
      controls.map(control => {
        const { top, right, bottom, left } = control.getBoundingClientRect();
        return { top, right, bottom, left };
      }));
    assert.equal(boxes.length, 3, 'two API-key inputs and their Save button are visible');
    assert.ok(referenceGap > 0, 'the Settings reference has a positive field-to-save gap');
    for (const input of boxes.slice(0, -1))
      assert.ok(Math.abs(boxes.at(-1).top - input.bottom - referenceGap) < 0.5, 'each API-key input matches the Settings field-to-save gap');
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      assert.ok(a.right < b.left || b.right < a.left || a.bottom < b.top || b.bottom < a.top,
        `API-key controls ${i + 1} and ${j + 1} neither touch nor overlap`);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
