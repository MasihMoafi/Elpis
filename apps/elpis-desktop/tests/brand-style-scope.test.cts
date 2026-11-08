// The wordmark's own <style> stays inside the wordmark (1 Nov: its `.light { opacity:0 }` hid the whole light-theme
// Workflows board, whose React Flow root has the class `light`; the agents were there and clickable but invisible).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cts');

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

test('the light on the new-chat wordmark keeps moving after its first sweep', async () => {
  const f = await openCanvas(); const { page } = f;
  try {
    await page.getByRole('button', { name: 'New chat', exact: true }).click();
    const sweep = page.locator('.empty-state .empty-mark .light');
    await sweep.waitFor({ state: 'attached' });
    for (const theme of ['light', 'dark']) {
      const isDark = await page.locator('html').evaluate((element: Element) => element.classList.contains('dark'));
      if (isDark !== (theme === 'dark')) await page.getByRole('button', { name: `Use ${theme} theme` }).click();
      await page.locator(`.empty-mark [id$="-word-${theme}-title"]`).waitFor({ state: 'attached' });
      const frames = await sweep.evaluate(async (element: Element) => {
        const animation = element.getAnimations().find((item: Animation) => (item as CSSAnimation).animationName.endsWith('-sweep'));
        if (!animation) return null;
        animation.pause();
        animation.currentTime = 7350;
        await new Promise(requestAnimationFrame);
        const first = { opacity: getComputedStyle(element).opacity, transform: getComputedStyle(element).transform };
        animation.currentTime = 7850;
        await new Promise(requestAnimationFrame);
        return { iterations: animation.effect?.getTiming().iterations, first,
          second: { opacity: getComputedStyle(element).opacity, transform: getComputedStyle(element).transform } };
      });
      assert.ok(frames, `${theme}: the sweep exists`);
      assert.equal(frames.iterations, Infinity, `${theme}: the sweep repeats`);
      assert.ok(Number(frames.first.opacity) > 0, `${theme}: the light is visible on its second pass (${JSON.stringify(frames)})`);
      assert.notEqual(frames.first.transform, frames.second.transform, `${theme}: the light moves on its second pass`);
    }
    assert.equal(await page.locator('.brand .size-wordmark .light').evaluate((element: Element) =>
      getComputedStyle(element).animationIterationCount), '1', 'the sidebar wordmark still plays once');
  } finally { await f.close(); }
});
