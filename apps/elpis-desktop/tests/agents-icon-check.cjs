const assert = require('node:assert/strict');
const { AGENTS_ARTWORK } = require('../components/agents-artwork.ts');

/** Shared assertions for the real Electron app and the renderer regression. */
async function checkAgentsIcon(page) {
  const button = page.getByRole('button', { name: /^(Show|Hide) agents panel$/ });
  await button.waitFor();
  assert.deepEqual({
    agentsArtwork: await button.locator('svg[data-icon="agents"]').count(),
    genericPanelRight: await button.locator('.lucide-panel-right, .lucide-panel-right-close, .lucide-panel-right-open').count(),
  }, { agentsArtwork: 1, genericPanelRight: 0 }, 'Agents renders the generated agents artwork and no generic panel glyph');
  const icon = button.locator('svg');
  const attributes = await icon.evaluate(svg => ({ fill: svg.getAttribute('fill'), hidden: svg.getAttribute('aria-hidden'), paths: svg.querySelectorAll('path').length, raster: svg.querySelectorAll('image,script,foreignObject').length }));
  assert.deepEqual(attributes, { fill: 'currentColor', hidden: 'true', paths: 1, raster: 0 });
  const metrics = await button.evaluate(button => {
    const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return [...button.parentElement.querySelectorAll('.header-action')].filter(el => el.querySelector('svg')).map(el => ({ label: el.getAttribute('aria-label'), button: box(el), icon: box(el.querySelector('svg')) }));
  });
  const own = metrics.find(m => /agents panel$/.test(m.label)), neighbour = metrics.find(m => m.label === 'Refresh conversation');
  assert.ok(neighbour, 'refresh control is the reference neighbour');
  for (const dimension of ['w', 'h']) {
    assert.equal(own.button[dimension], neighbour.button[dimension], `same button ${dimension}`);
    assert.equal(own.icon[dimension], neighbour.icon[dimension], `same icon ${dimension}`);
  }
  assert.ok(Math.abs(own.icon.y + own.icon.h / 2 - neighbour.icon.y - neighbour.icon.h / 2) < 0.6, 'icons share a vertical centre');
  assert.ok(Math.abs(own.icon.x + own.icon.w / 2 - own.button.x - own.button.w / 2) < 0.6, 'icon is centred in its button');
  const d = await icon.locator('path').getAttribute('d');
  assert.ok(d === AGENTS_ARTWORK.d, 'the button shows the selected generated agents artwork, including after reload');
  assert.equal(await icon.getAttribute('viewBox'), AGENTS_ARTWORK.viewBox, 'the artwork retains its optical padding');
  if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
  const heading = page.locator('.team-heading svg[data-icon="agents"]');
  await heading.waitFor({ state: 'attached' });
  assert.equal(await heading.locator('path').getAttribute('d'), d, 'panel header uses the same component artwork');
  await button.click();
  assert.equal(await page.locator('.team-panel').count(), 0, 'mouse closes the panel');
  assert.equal(await button.locator('path').getAttribute('d'), d, 'closed state retains the same agents icon');
  await button.press('Enter');
  await page.locator('.team-panel').waitFor({ state: 'attached' });
  assert.equal(await button.getAttribute('aria-pressed'), 'true', 'keyboard reopens the panel');
  return { metrics, path: d };
}
module.exports = { checkAgentsIcon };
