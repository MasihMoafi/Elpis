const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

// Replace a mounted view's render function in the test browser, then use the
// real theme subscription to render it. No failure switch ships in the app.
async function throwView(page, selector) {
  await page.locator(selector).first().evaluate(element => {
    let fiber = element[Object.keys(element).find(key => key.startsWith('__reactFiber$'))];
    while (fiber && typeof fiber.type !== 'function') fiber = fiber.return;
    if (!fiber) throw Error('No view component found');
    const render = fiber.type;
    window.__viewFailure = true;
    const throwing = function (...args) {
      if (window.__viewFailure) throw Error('Deliberate view failure');
      return render.apply(this, args);
    };
    fiber.type = throwing;
    if (fiber.alternate) fiber.alternate.type = throwing;
  });
  await page.emulateMedia({ colorScheme: await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark') });
}

for (const view of [
  { name: 'Love Spot', selector: '.love-spot' },
  { name: 'Workflows', selector: 'section[aria-label="Workflows"]' },
  // dd2ca3576 labels navigation buttons too; inject the failure in the Customize view.
  { name: 'Customize', selector: '.customize[aria-label="Customize"]' },
  { name: 'Settings', selector: '.settings-layout' },
  { name: 'Chat', selector: '.elpis-features' },
]) test(`${view.name} catches a deliberate render failure, reloads, and leaves navigation usable`, async () => {
  const f = await fixture({ width: 1280, height: 800, desktop: false });
  const { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    if (view.name === 'Settings') await openSettings(page);
    else if (view.name === 'Chat') await f.open('chat-a');
    else await page.locator('.nav-list').getByRole('button', { name: view.name, exact: true }).click();
    await page.locator(view.selector).first().waitFor({ state: 'attached' });
    await throwView(page, view.selector);
    const error = page.locator('.view-error').filter({ hasText: 'Deliberate view failure' });
    await error.waitFor();
    assert.equal(await page.locator('.nav-list').isVisible(), true, 'the sidebar remains usable');
    if (process.env.ELPIS_MORNING_SHOTS && ['Love Spot', 'Settings'].includes(view.name)) {
      await fs.mkdir(process.env.ELPIS_MORNING_SHOTS, { recursive: true });
      await page.waitForTimeout(1100);
      await page.screenshot({ path: path.join(process.env.ELPIS_MORNING_SHOTS, `${view.name.replaceAll(' ', '-')}-error-dark.png`) });
    }
    await page.evaluate(() => { window.__viewFailure = false; });
    await error.getByRole('button', { name: 'Reload', exact: true }).click();
    await page.locator(view.selector).first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('.view-error').count(), 0, 'Reload remounts the view');
    // Crash again, then navigate away with a real click instead of reloading.
    await throwView(page, view.selector);
    await error.waitFor();
    if (process.env.ELPIS_MORNING_SHOTS && ['Love Spot', 'Settings'].includes(view.name)) {
      await page.waitForTimeout(1100);
      await page.screenshot({ path: path.join(process.env.ELPIS_MORNING_SHOTS, `${view.name.replaceAll(' ', '-')}-error-light.png`) });
    }
    await page.locator('.nav-list').getByRole('button', { name: 'New chat', exact: true }).click();
    await f.composer.waitFor();
    assert.equal(await f.composer.isEnabled(), true);
    assert.equal(await page.locator('.view-error:visible').count(), 0);
  } finally { await f.close(); }
});

test('the complete sidebar wordmark fits its SVG viewport and toggle at desktop widths in both themes', async () => {
  const f = await fixture({ width: 1280, height: 800, desktop: false });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await page.waitForTimeout(1100); // The final letter arrives at 0.95 seconds.
      for (const width of [1280, 1440, 1600]) {
        await page.setViewportSize({ width, height: 800 });
        const clipped = await page.locator('.brand img').evaluate(async image => {
          const source = await (await fetch(image.src)).text();
          const host = document.createElement('div');
          host.innerHTML = source; document.body.append(host);
          const svg = host.querySelector('svg');
          for (const node of svg.querySelectorAll('*')) node.style.animation = 'none';
          const box = svg.querySelector('g[id$="shape"]').getBBox(), view = svg.viewBox.baseVal;
          // The wordmark is the logo's home button (6556d5e50): measure it against the brand row and its toggle.
          const bounds = image.getBoundingClientRect(), parent = image.closest('.brand').getBoundingClientRect();
          const toggle = image.closest('.brand').querySelector('.sidebar-toggle').getBoundingClientRect();
          const result = { svgClipped: box.x < view.x || box.x + box.width > view.x + view.width,
            layoutClipped: bounds.right > parent.right || bounds.left < toggle.right };
          host.remove(); return result;
        });
        assert.deepEqual(clipped, { svgClipped: false, layoutClipped: false }, `${colorScheme} ${width}`);
      }
      if (process.env.ELPIS_MORNING_SHOTS) {
        await fs.mkdir(process.env.ELPIS_MORNING_SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ELPIS_MORNING_SHOTS, `wordmark-${colorScheme}.png`) });
      }
    }
  } finally { await f.close(); }
});
