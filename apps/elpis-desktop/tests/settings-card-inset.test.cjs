// No control in a settings card touches the card's edge (1 Nov, Masih, of Delete theme and Save theme on the card's corner:
// "these things on the low right shouldn't be so stuck to their surface"). Every tab, so a new card cannot regress it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

test('every button and field in a settings card keeps an inset from the card edge, on every tab', { timeout: 120000 }, async t => {
  const f = await fixture({ width: 1400, height: 900 }), { page } = f; t.after(f.close);
  await f.open('chat-a');
  await openSettings(page);
  const tabs = await page.getByRole('tab').evaluateAll(els => els.map(el => el.textContent.trim()).filter(Boolean));
  assert.ok(tabs.includes('Appearance'), `settings tabs found: ${tabs.join(', ')}`);
  const touching = [];
  for (const name of tabs) {
    await page.getByRole('tab', { name, exact: true }).click();
    await page.getByRole('tabpanel', { name, exact: true }).waitFor();
    if (name === 'Appearance') { await page.getByRole('button', { name: 'Create theme', exact: true }).click(); await page.getByRole('button', { name: 'Save theme', exact: true }).waitFor(); }
    touching.push(...await page.evaluate(tab => [...document.querySelectorAll('[role="tabpanel"] .settings-rows')].flatMap(card => {
      const box = card.getBoundingClientRect();
      return [...card.querySelectorAll('button, input, textarea, [role="combobox"]')].flatMap(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4 || getComputedStyle(el).opacity === '0' || getComputedStyle(el).visibility === 'hidden') return []; // hidden native inputs behind switches and radios
        const gaps = [r.left - box.left, box.right - r.right, r.top - box.top, box.bottom - r.bottom];
        return Math.min(...gaps) < 8 ? [`${tab}: ${el.getAttribute('aria-label') || el.textContent.trim() || el.tagName} ${gaps.map(Math.round).join('/')}`] : [];
      });
    }), name));
  }
  assert.deepEqual(touching, [], 'controls closer than 8 px to their card edge (left/right/top/bottom)');
  assert.deepEqual(f.errors, []);
});
