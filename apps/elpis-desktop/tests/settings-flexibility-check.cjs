const assert = require('node:assert/strict');
const { openSettings } = require('./controls.cjs');
const { drag, shot } = require('./settings-reorder-check.cjs');

const navigation = page => page.getByRole('navigation', { name: 'Settings navigation' });
const group = (page, label) => navigation(page).locator('.settings-nav-group').filter({ has: page.getByRole('button', { name: label, exact: true }) });
const pageRow = (page, label) => navigation(page).getByRole('tab', { name: label, exact: true });
const layout = page => navigation(page).locator('.settings-nav-group').evaluateAll(groups => groups.map(group => ({
  name: group.querySelector('[data-slot="section-link"]').textContent,
  pages: [...group.querySelectorAll('[role="tab"]')].map(row => row.id),
})));

// Uses native pointer dragging, shared by the renderer regression and packaged-app acceptance script.
async function crossGroup(page, { theme, shots } = {}) {
  await openSettings(page);
  const original = await layout(page);
  const app = group(page, 'App & terminal');
  const context = group(page, 'Context & maintenance');
  // Move the sole Context page into another group; the now empty group must remain a drop target.
  let mark;
  await drag(page, pageRow(page, 'Personalization'), pageRow(page, 'General'), false, false, async () => {
    await shot(page, shots, `cross-group-drag-${theme}`);
    mark = await pageRow(page, 'General').getAttribute('data-drop');
  });
  await shot(page, shots, `cross-group-result-${theme}`);
  assert.equal(mark, 'before', 'cross-group targets show the shared chat insertion mark');
  assert.deepEqual((await app.getByRole('tab').allTextContents()).slice(0, 2), ['Personalization', 'General']);
  assert.equal(await context.getByRole('tab').count(), 0);
  // Middle and last insertion in a different group, in addition to the first insertion above.
  await drag(page, pageRow(page, 'Voice'), pageRow(page, 'Notifications'), true);
  await drag(page, pageRow(page, 'Git'), app.getByRole('tab').last(), true);
  assert.equal(await app.getByRole('tab').last().textContent(), 'Git');
  // A group heading accepts pages even when empty; groups themselves still reorder.
  await drag(page, pageRow(page, 'Personalization'), context.locator('[data-slot="section-link"]'));
  assert.deepEqual(await context.getByRole('tab').allTextContents(), ['Personalization']);
  const headers = navigation(page).locator('[data-slot="section-link"]');
  await drag(page, headers.last(), headers.first());
  const expected = await layout(page);
  await drag(page, pageRow(page, 'General'), pageRow(page, 'Models & accounts'), false, true);
  assert.deepEqual(await layout(page), expected, 'Escape cancels a cross-group move');
  await page.reload();
  await openSettings(page);
  assert.deepEqual(await layout(page), expected, 'group membership and both orders survive reload');
  assert.equal(expected.flatMap(item => item.pages).length, original.flatMap(item => item.pages).length, 'no page lost or duplicated');
  await shot(page, shots, `cross-group-reload-${theme}`);
  return expected;
}
module.exports = { crossGroup, layout, group, pageRow };
