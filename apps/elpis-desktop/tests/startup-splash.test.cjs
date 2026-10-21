// The Elpis website's boot screen (website/index.html, paintAceLogo): the ELPIS logo with its gold sweep, dark in both themes.
// Masih, 18 Oct: "just use the normal Elpis animation from my website in the app; default dark mode version"; no ribbon (20 Oct).
// Runs the exported renderer against the mock bridge; no engine or real desktop profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

/** Reloads the app with the named API paths held until released, so the splash stays observable. */
async function starting(t, { colorScheme = 'light', reducedMotion = 'no-preference', hold = ['/api/health'], freeze = false, failModels = false } = {}) {
  const f = await fixture({ width: 1280, height: 900, colorScheme });
  const gates = {};
  t.after(async () => { for (const open of Object.values(gates)) open(); await f.close(); assert.deepEqual(f.errors, []); });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  await f.page.emulateMedia({ reducedMotion });
  const time = new Date();
  await f.page.clock.install({ time });
  if (freeze) await f.page.clock.pauseAt(new Date(time.getTime() + 1000));
  for (const pathname of hold) {
    const gate = new Promise(resolve => { gates[pathname] = resolve; });
    await f.page.route(url => url.pathname === pathname, async route => { await gate; await route.fallback(); });
  }
  // A failed model catalogue must not prevent the readiness signal from dismissing the splash.
  if (failModels) await f.page.route(url => url.pathname === '/api/models', route => route.fulfill({ status: 503, json: { error: 'Fixture catalogue unavailable' } }));
  await f.page.reload({ waitUntil: 'domcontentloaded' });
  await f.page.locator('.startup-splash').waitFor();
  return { ...f, release: pathname => gates[pathname ?? hold[0]]() };
}

/** Columns of the logo's first row that the gold sweep is lighting ("hot", as on the website). */
const hot = page => page.evaluate(() => {
  let column = 0; const lit = [];
  for (const node of document.querySelector('.splash-logo').firstElementChild.childNodes) {
    if (node.nodeType === 1 && node.classList.contains('hot')) lit.push(column);
    column += node.textContent.length;
  }
  return lit;
});

for (const colorScheme of ['light', 'dark']) test(`startup: the website's ELPIS boot screen and its gold sweep (${colorScheme})`, async t => {
  const { page } = await starting(t, { colorScheme, freeze: true });
  const splash = page.locator('.startup-splash');
  const rows = await page.locator('.splash-logo').evaluate(el => el.textContent.trimEnd().split('\n'));
  assert.deepEqual([rows.length, rows[0]], [6, '███████╗ ██╗     ██████╗ ██╗███████╗'], 'The website logo, with the E\'s first block restored');
  await splash.getByText('portable context for terminal coding agents').waitFor();
  assert.match(await splash.locator('.splash-log').innerText(), /· Elpis engine connected[\s\S]*conversations loaded[\s\S]*\[[█░]{12}\]/, 'Boot lines wait for the engine they name');
  assert.equal(await splash.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(8, 11, 9)', 'The website\'s dark default even when the app theme is light');
  assert.equal(await splash.locator('img, .splash-ribbon, .splash-name').count(), 0, 'No rotating M→E symbol and no ribbon');
  await page.clock.runFor(400); const early = await hot(page);
  await page.clock.runFor(400); const later = await hot(page);
  assert.ok(early.length && later.length && later[0] > early[0], `The gold sweep runs left to right: ${early} → ${later}`);
  if (process.env.ELPIS_SPLASH_SHOTS) {
    await fs.mkdir(process.env.ELPIS_SPLASH_SHOTS, { recursive: true });
    for (const name of ['0.8', '1.2', '1.6']) {
      await page.screenshot({ path: path.join(process.env.ELPIS_SPLASH_SHOTS, `${colorScheme}-${name}.png`) });
      await page.clock.runFor(400);
    }
  }
});

test('startup: the splash waits for conversations even after the engine connects', async t => {
  const { page, release } = await starting(t, { colorScheme: 'dark', hold: ['/api/health', '/api/threads'] });
  const response = page.waitForResponse(url => url.url().endsWith('/api/health'));
  release('/api/health');
  await response;
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.startup-splash.leaving').count(), 0, 'The chats are not in yet');
  assert.match(await page.locator('.splash-log').innerText(), /✓ Elpis engine connected[\s\S]*· conversations loaded/, 'Each boot line is ticked only when its part has loaded');
  release('/api/threads');
  await page.locator('.startup-splash.leaving').waitFor({ state: 'attached' });
});

test('reduced motion (GNOME animations off): nothing moves, but the gold sweep still runs as a colour change', async t => {
  const { page } = await starting(t, { colorScheme: 'dark', reducedMotion: 'reduce', freeze: true });
  const splash = page.locator('.startup-splash');
  assert.equal(await splash.evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'No CSS movement');
  assert.equal(await page.locator('.splash-logo').evaluate(el => getComputedStyle(el).transform), 'none');
  await page.clock.runFor(400); const early = await hot(page);
  await page.clock.runFor(400); const later = await hot(page);
  assert.ok(early.length && later.length && later[0] > early[0], `Masih's desktop has animations off; the sweep must still play: ${early} → ${later}`);
  if (process.env.ELPIS_SPLASH_SHOTS) await page.screenshot({ path: path.join(process.env.ELPIS_SPLASH_SHOTS, 'reduced-motion.png') });
});

test('readiness starts a short fade immediately and real mouse clicks pass through it', async t => {
  const { page, composer, release } = await starting(t, { freeze: true, failModels: true });
  const box = await composer.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  assert.equal(await composer.evaluate(el => el === document.activeElement), false, 'The pending splash covers the app');
  assert.equal(await page.locator('.startup-splash.leaving').count(), 0);
  release();
  const leaving = page.locator('.startup-splash.leaving');
  await leaving.waitFor({ state: 'attached' });
  const fade = await leaving.evaluate(el => ({ pointerEvents: getComputedStyle(el).pointerEvents, seconds: parseFloat(getComputedStyle(el).transitionDuration) }));
  assert.equal(fade.pointerEvents, 'none'); assert.ok(fade.seconds <= .3);
  await page.mouse.click(x, y); await page.keyboard.type('Draft during startup fade');
  assert.equal(await composer.inputValue(), 'Draft during startup fade');
  assert.equal(await leaving.count(), 1, 'The real click arrived while the fading splash was still mounted');
  await page.clock.runFor(300);
  assert.equal(await page.locator('.startup-splash').count(), 0, 'The splash is removed within 300 ms of readiness');
});

test('a stalled startup still gives way after the existing eight-second fallback', async t => {
  const { page } = await starting(t);
  await page.waitForTimeout(7000);
  assert.equal(await page.locator('.startup-splash.leaving').count(), 0);
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 2000 });
});
