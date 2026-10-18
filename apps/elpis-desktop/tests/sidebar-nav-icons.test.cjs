// Each workspace page in the sidebar has an icon from one family: a vector that takes the text colour. On 18 Oct Love
// Spot showed a 512px photo instead. Local bridge fixture (tests/parity-fixture.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('every sidebar page icon is a text-coloured vector, Love Spot included', async () => {
  const f = await fixture({ width: 1280 });
  try {
    const nav = f.page.locator('aside.sidebar nav[aria-label="Workspace"]');
    await nav.getByRole('button', { name: 'Love Spot', exact: true }).waitFor();
    const icons = await nav.locator('button').evaluateAll(buttons => buttons.map(button => {
      const icon = button.firstElementChild, paint = icon?.tagName === 'svg' ? icon.getAttribute('fill') === 'currentColor' || icon.getAttribute('stroke') === 'currentColor' : false;
      return `${button.textContent.trim()}: ${icon?.tagName}${paint ? ' currentColor' : ''}`;
    }));
    assert.ok(icons.some(line => line.startsWith('Love Spot')), icons.join('\n'));
    assert.deepEqual(icons.filter(line => !line.endsWith('svg currentColor')), [], 'icons outside the family');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
