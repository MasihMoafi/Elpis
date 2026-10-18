// Startup (components/startup-splash.tsx), in the isometric lab's HUD style: the amber Elpis E from public/branding
// inside the old send button's hexagon, which turns; the E turns a quarter turn clockwise into an M (Elpis by Masih)
// and back; tick marks, a sweeping line, and boot lines that tick as the engine, the models and the chats are ready.
// Mock bridge (tests/parity-fixture.cjs); frames go to $ELPIS_SPLASH_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { oranges } = require('./controls.cjs');

/** The old send button's hexagon (8f64748ce: `clip-path:polygon(25% 0, 75% 0, 100% 50%, 75% 100%, 25% 100%, 0 50%)`). */
const OLD_HEX = [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]];
const LABELS = ['Elpis engine connected', 'models loaded', 'conversations loaded'];

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

/** Pauses every splash animation at `ms` into its cycle and reads the logo's and the hexagon's turn, in degrees. */
const frame = (page, ms) => page.evaluate(ms => {
  for (const animation of document.querySelector('.startup-splash').getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = ms; }
  const angle = element => { const value = getComputedStyle(element).transform; if (value === 'none') return 0; const [a, b] = value.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number); return Math.round(Math.atan2(b, a) * 180 / Math.PI); };
  const logo = document.querySelector('.splash-logo'), box = logo.getBoundingClientRect();
  return { logo: angle(logo), hex: angle(document.querySelector('.splash-hex')), centre: [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)] };
}, ms);

for (const colorScheme of ['light', 'dark']) test(`startup: the amber Elpis E in the old hexagon, which turns; the E turns to an M and back (${colorScheme})`, async t => {
  const { page } = await starting(t, { colorScheme });
  const splash = page.locator('.startup-splash');
  // The logo is the brand file, loaded, not a generic icon.
  const logo = page.locator('.splash-logo');
  assert.match(await logo.getAttribute('src'), /\/branding\/elpis-symbol-amber\.svg$/);
  await page.waitForFunction(() => document.querySelector('.splash-logo')?.naturalWidth > 0);
  assert.equal(await splash.locator('svg path[d^="M 71.1 52.0"]').count(), 0, 'not the send arrow');
  // The old send button's hexagon, as a plate the logo sits inside, centred on the window.
  const geometry = await page.evaluate(() => {
    const plate = document.querySelector('.splash-hex-plate'), points = [...plate.points].map(point => [point.x, point.y]);
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]), left = Math.min(...xs), top = Math.min(...ys), size = Math.max(...xs) - left;
    // The plate turns, so its size comes from its points and its screen scale, and the logo's from its layout box.
    const ctm = plate.getScreenCTM(), hex = plate.getBoundingClientRect(), image = document.querySelector('.splash-logo'), logo = image.getBoundingClientRect();
    const splash = document.querySelector('.startup-splash');
    return { normalised: points.map(([x, y]) => [(x - left) / size, (y - top) / (Math.max(...ys) - top)]),
      hex: [hex.x + hex.width / 2, hex.y + hex.height / 2, size * Math.hypot(ctm.a, ctm.b)], logo: [logo.x + logo.width / 2, logo.y + logo.height / 2, image.offsetWidth, image.offsetHeight],
      background: getComputedStyle(splash).backgroundColor, app: getComputedStyle(document.body).backgroundColor,
      ticks: document.querySelectorAll('.splash-ticks line').length, sweep: document.querySelector('.splash-sweep')?.getAnimations().length ?? 0,
      name: document.querySelector('.splash-name')?.textContent, boot: [...document.querySelectorAll('.splash-boot li')].map(item => item.textContent.replace(/^[✓·]\s*/, '')) };
  });
  geometry.normalised.forEach(([x, y], index) => { assert.ok(Math.abs(x - OLD_HEX[index][0]) < 0.01 && Math.abs(y - OLD_HEX[index][1]) < 0.01, `hexagon corner ${index}: ${x},${y}`); });
  assert.ok(Math.abs(geometry.hex[0] - 640) < 1, `centred across the window: ${geometry.hex[0]}`);
  assert.ok(Math.abs(geometry.logo[0] - geometry.hex[0]) < 1 && Math.abs(geometry.logo[1] - geometry.hex[1]) < 1, 'the logo sits at the hexagon\'s centre');
  // Turned any way, the logo's box stays inside the hexagon's inscribed circle (0.447 of its width).
  assert.ok(Math.hypot(geometry.logo[2], geometry.logo[3]) / 2 <= 0.447 * geometry.hex[2], 'the logo fits inside the hexagon at any turn');
  assert.equal(geometry.background, geometry.app, 'the splash is the app\'s own ground');
  assert.ok(geometry.ticks >= 24, `tick marks round the hexagon (${geometry.ticks})`);
  assert.ok(geometry.sweep > 0, 'a line sweeps the plate');
  assert.equal(geometry.name, 'Elpis');
  assert.deepEqual(geometry.boot, LABELS);
  if (colorScheme === 'light') assert.deepEqual(await oranges(page), [], 'light theme, startup: no orange outside the logo itself');
  // The cycle: the E rests, turns a quarter turn clockwise to an M while the hexagon turns, rests, and turns back.
  const e = await frame(page, 300), mid = await frame(page, 1300), m = await frame(page, 2100), back = await frame(page, 3800);
  assert.equal(e.logo, 0, 'E: the logo upright');
  assert.ok(mid.logo > 20 && mid.logo < 70, `mid-turn: ${mid.logo}°`);
  assert.equal(m.logo, 90, 'M: a quarter turn clockwise');
  assert.equal(back.logo, 0, 'and back to the E');
  assert.notEqual(m.hex, e.hex, 'the hexagon turns with it');
  assert.deepEqual(m.centre, e.centre, 'the logo turns about its own centre');
  if (process.env.ELPIS_SPLASH_SHOTS) {
    await fs.mkdir(process.env.ELPIS_SPLASH_SHOTS, { recursive: true });
    for (const [name, ms] of [['e', 300], ['mid', 1300], ['m', 2100]]) { await frame(page, ms); await page.screenshot({ path: path.join(process.env.ELPIS_SPLASH_SHOTS, `${colorScheme}-${name}.png`) }); }
  }
});

test('startup: each boot line ticks when its part is ready, and the splash stays until the chats are in', async t => {
  const { page, release } = await starting(t, { colorScheme: 'dark', hold: ['/api/health', '/api/threads'] });
  const states = () => page.locator('.splash-boot li').evaluateAll(items => items.map(item => item.dataset.ok));
  const meter = () => page.locator('.splash-meter i[data-on]').count();
  assert.deepEqual(await states(), ['false', 'false', 'false'], 'nothing is ready yet');
  assert.equal(await meter(), 0);
  release('/api/health');
  await page.waitForFunction(() => [...document.querySelectorAll('.splash-boot li')].map(item => item.dataset.ok).join() === 'true,true,false');
  assert.equal(await meter(), 8, 'two of three parts: eight of twelve segments');
  assert.equal(await page.locator('.startup-splash.leaving').count(), 0, 'the chats are not in yet');
  release('/api/threads');
  await page.locator('.startup-splash.leaving').waitFor({ state: 'attached' });
});

test('reduced motion: nothing on the startup splash moves and the E stays upright', async t => {
  const { page } = await starting(t, { colorScheme: 'dark', reducedMotion: 'reduce' });
  const splash = page.locator('.startup-splash');
  assert.equal(await splash.evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'Reduced motion must stop all splash animation');
  assert.equal(await page.locator('.splash-logo').evaluate(el => getComputedStyle(el).transform), 'none');
  const before = await splash.innerHTML(); await page.waitForTimeout(140);
  assert.equal(await splash.innerHTML(), before, 'No JavaScript animation continues in reduced motion');
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
