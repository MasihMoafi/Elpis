const assert = require('node:assert/strict');
const { leaveSettings, openSettings } = require('./controls.cjs');

async function openAccounts(page) {
  await leaveSettings(page);
  await page.waitForFunction(() => { const composer = document.querySelector('textarea[aria-label="Message Elpis"]'); return composer && !composer.disabled; });
  if (!await page.locator('aside.sidebar .account-row').isVisible()) await page.keyboard.press('Control+b');
  await openSettings(page, 'Models & accounts');
}

// Shared by the renderer regression and the packaged app check: inspect both DOM order and painted positions.
async function accountsFirst(page) {
  const panel = page.getByRole('tabpanel', { name: 'Models & accounts', exact: true });
  await panel.locator('[data-provider="gemini"]').waitFor();
  const order = await panel.evaluate(panel => {
    const advanced = panel.querySelector('.provider-advanced');
    const cards = [...panel.querySelectorAll('.provider-card')];
    const form = panel.querySelector('form[aria-label="API provider settings"]');
    return {
      first: panel.querySelector('.settings-stack > .settings-card')?.getAttribute('data-provider'),
      cards: cards.map(card => ({ id: card.dataset.provider,
        before: !!(card.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING),
        above: card.getBoundingClientRect().bottom <= advanced.getBoundingClientRect().top,
        beforeForm: !form || !!(card.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING),
        aboveForm: !form || card.getBoundingClientRect().bottom <= form.getBoundingClientRect().top })),
    };
  });
  assert.equal(order.first, 'openai', 'the API section must not be the first card');
  assert.ok(order.cards.length >= 3, 'all three subscription sections remain present');
  for (const card of order.cards) {
    assert.ok(card.before && card.above, `${card.id} precedes Advanced API connections in the DOM and on screen`);
    assert.ok(card.beforeForm && card.aboveForm, `${card.id} precedes the open API form in the DOM and on screen`);
  }
  return panel;
}

module.exports = { accountsFirst, openAccounts };
