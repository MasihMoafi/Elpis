// The wordmark's own <style> stays inside the wordmark (1 Nov: its `.light { opacity:0 }` hid the whole light-theme
// Workflows board, whose React Flow root has the class `light`; the agents were there and clickable but invisible).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');

test('in the light theme the flat Workflows board is drawn while the wordmark is on screen; the wordmark keeps its sweep', async () => {
  const f = await openCanvas(); const { page, canvas } = f;
  try {
    await canvas.locator('.react-flow__node-agent').first().waitFor();
    const seen = await page.evaluate(() => {
      const flow = document.querySelector('.react-flow'), sweep = document.querySelector('.size-wordmark .light');
      if (!flow) throw new Error('Workflows board is missing');
      return { light: flow.classList.contains('light'), flow: getComputedStyle(flow).opacity, wordmark: !!document.querySelector('.size-wordmark'),
        sweep: sweep ? sweep.getAnimations().length : -1 };
    });
    assert.equal(seen.light, true, 'the board is in its light mode');
    assert.equal(seen.wordmark, true, 'the wordmark is on screen');
    assert.equal(seen.flow, '1', 'the board is visible');
    assert.ok(seen.sweep >= 1, 'the wordmark still plays its light sweep');
  } finally { await f.close(); }
});
