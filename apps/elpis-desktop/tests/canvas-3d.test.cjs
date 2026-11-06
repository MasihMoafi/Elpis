const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');

test('3D selection, dashboard, shared settings and delete/undo work together', async () => {
  const f = await openCanvas(); const { page, canvas } = f;
  try {
    await canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
    const agent = canvas.locator('.iso-node[aria-label^="Quillon · Part 1:"]');
    await agent.click(); await canvas.locator('.iso-node[aria-label^="Veyra · Part 2:"]').click({ modifiers: ['Shift'] });
    assert.equal(await canvas.locator('.iso-node[aria-pressed="true"]').count(), 2);
    await agent.click(); await page.keyboard.press('Enter');
    const dashboard = canvas.getByRole('dialog', { name: 'Quillon · Part 1 info', exact: true }); await dashboard.waitFor();
    await dashboard.getByRole('button', { name: 'Settings', exact: true }).click();
    const panel = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    await panel.getByRole('textbox', { name: 'Prompt', exact: true }).fill('A shared prompt');
    await agent.click(); await page.keyboard.press('Delete');
    assert.equal(await canvas.locator('.iso-node[data-kind="agent"]').count(), 3);
    await page.keyboard.press('Control+z');
    assert.equal(await canvas.locator('.iso-node[data-kind="agent"]').count(), 4);
    assert.equal((await f.saved()).nodes.find(n => n.data.title === 'Quillon · Part 1').data.instruction, 'A shared prompt');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('3D labels select and open the matching agent', async () => {
  const f = await openCanvas();
  try {
    await f.canvas.getByRole('radio', { name: 'Isometric', exact: true }).click();
    const label = f.canvas.locator('.iso-label').filter({ hasText: 'Veyra · Part 2' });
    await label.click();
    assert.equal(await f.canvas.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Veyra · Part 2');
    await label.dblclick();
    await f.canvas.getByRole('textbox', { name: 'Rename agent', exact: true }).waitFor();
    await f.page.keyboard.press('Escape'); await label.click(); await f.page.keyboard.press('Enter');
    await f.canvas.getByRole('dialog', { name: 'Veyra · Part 2 info', exact: true }).waitFor();
  } finally { await f.close(); }
});
