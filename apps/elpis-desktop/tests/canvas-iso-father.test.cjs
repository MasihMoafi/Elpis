// The isometric view draws what the flat board draws: past the Mother's ten agents the Father on his own pillar,
// starting his agents, and two-way (alongside) wires with no arrows, since they set no order.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');

test('isometric: the Father and his wires past ten agents, and two-way wires without arrows', async () => {
  const { page, canvas, node, agentCount, fit, errors, close } = await openCanvas();
  try {
    const off = () => page.evaluate(() => document.activeElement?.blur());
    await agentCount(4, 'the default board');
    await canvas.getByRole('button', { name: 'Mother', exact: true }).click();
    await canvas.getByRole('complementary', { name: 'Mother', exact: true }).getByRole('textbox', { name: 'Max agents', exact: true }).fill('13');
    await off(); await page.keyboard.press('Tab');
    await canvas.getByRole('dialog', { name: 'Add agents', exact: true }).getByRole('textbox', { name: 'Command', exact: true }).waitFor();
    await page.keyboard.type(`9: ${Array.from({ length: 9 }, (_, index) => `Task ${index + 1}`).join('; ')}`);
    await page.keyboard.press('Enter');
    await agentCount(13, 'nine added');
    // Task 1 and Task 2 work alongside: Alt held while wiring.
    await fit();
    const dot = await node('Task 1').locator('.react-flow__handle.source').boundingBox(), body = await node('Task 2').boundingBox();
    await page.keyboard.down('Alt');
    await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2); await page.mouse.down();
    await page.mouse.move(body.x + body.width / 2, body.y + body.height / 2, { steps: 10 }); await page.mouse.up();
    await page.keyboard.up('Alt');
    await canvas.locator('.react-flow__edge.canvas-edge-alongside').waitFor();
    const flatFatherWires = await canvas.locator('.react-flow__edge[data-id^="father->"]').count();
    assert.ok(flatFatherWires > 0, 'the flat board has the Father starting his agents');

    await canvas.getByRole('group', { name: 'Workflows view', exact: true }).getByRole('button', { name: 'Isometric', exact: true }).click();
    const board = canvas.getByRole('region', { name: 'Isometric board', exact: true }); await board.waitFor();
    // The Father stands on his own pillar, under the Mother, and starts the same agents as on the flat board.
    const father = board.getByRole('button', { name: /^Father:/ });
    assert.equal(await father.count(), 1, 'the Father is on the isometric board');
    assert.match(await father.getAttribute('aria-label'), /his own chat, 3 agents/);
    assert.equal(await board.locator('.iso-link[data-father]').count(), flatFatherWires, 'his wires, as on the flat board');
    assert.equal(await board.locator('.iso-link[data-mother]:not(.iso-mother-trunk)').count(), 10, 'the Mother starts only her ten');
    assert.equal(await board.locator('.iso-mother-trunk').count(), 1, 'all ten share one trunk');
    assert.equal(await board.locator('.iso-label[data-for="father"]').innerText(), 'Father');
    // The two-way wire shows, with no chevrons.
    const twoWay = board.locator('.iso-link[data-kind="alongside"]');
    assert.equal(await twoWay.count(), 1, 'the two-way wire is drawn');
    assert.equal(await twoWay.locator('.iso-chevron').count(), 0, 'no arrows on a two-way wire');
    // Clicking the Father names him in the status panel.
    await father.click();
    assert.match(await board.getByRole('region', { name: 'Agent status' }).innerText(), /Father[\s\S]*His own chat · 3 agents/);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
