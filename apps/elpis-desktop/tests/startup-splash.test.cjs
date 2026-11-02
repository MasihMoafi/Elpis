// The third E gyroscope animates at startup without surrounding rings.
// Runs the exported renderer against the mock bridge; no engine or real desktop profile.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

/** Observe the brief introduction with the browser clock paused; bridge data has its own tests. */
async function starting(t, { colorScheme = 'light', reducedMotion = 'no-preference', failModels = false } = {}) {
  const f = await fixture({ width: 1280, height: 900, colorScheme });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  await f.page.emulateMedia({ reducedMotion });
  const time = new Date();
  await f.page.clock.install({ time });
  await f.page.clock.pauseAt(time);
  // A failed model catalogue must not prevent the readiness signal from dismissing the splash.
  if (failModels) await f.page.route(url => url.pathname === '/api/models', route => route.fulfill({ status: 503, json: { error: 'Fixture catalogue unavailable' } }));
  await f.page.reload({ waitUntil: 'domcontentloaded' });
  await f.page.locator('.startup-splash').waitFor();
  await f.page.clock.runFor(250);
  return f;
}

/** Seek the actual CSS motion rather than waiting for approximate wall-clock frames. */
const frame = (page, ms) => page.evaluate(ms => {
  for (const animation of document.querySelector('.startup-splash').getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = ms; }
  const logo = document.querySelector('.splash-logo'), box = document.querySelector('.splash-gyro').getBoundingClientRect();
  return { logo: getComputedStyle(logo).transform, centre: [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)] };
}, ms);

for (const colorScheme of ['light', 'dark']) test(`startup: the third E gyroscope turns without surrounding rings (${colorScheme})`, async t => {
  const { page } = await starting(t, { colorScheme });
  const splash = page.locator('.startup-splash');
  const logo = page.locator('.splash-logo');
  assert.match(await logo.getAttribute('src'), /\/branding\/elpis-symbol-amber\.svg$/);
  await page.waitForFunction(() => document.querySelector('.splash-logo')?.naturalWidth > 0);
  assert.equal(await splash.locator('svg').count(), 0, 'There is no surrounding ring or hexagon');
  assert.equal(await splash.locator('.splash-dial, .splash-ticks, .splash-arcs, .splash-hex, .splash-scope, .splash-sweep, .splash-boot-panel, .splash-boot, .splash-meter').count(), 0, 'No HUD parts remain');
  const ground = await splash.evaluate(el => ({ background: getComputedStyle(el).backgroundColor,
    before: getComputedStyle(el, '::before').backgroundImage, after: getComputedStyle(el, '::after').backgroundImage }));
  // Masih, 24 Oct: a dark opening before a light app is wrong; the opening follows the app's theme.
  assert.equal(ground.background, colorScheme === 'dark' ? 'rgb(10, 11, 13)' : 'rgb(251, 251, 250)', `The opening follows the ${colorScheme} theme`);
  assert.doesNotMatch(ground.before + ground.after, /repeating-linear-gradient/, 'No HUD floor grid remains');
  const m = await frame(page, 0), mid = await frame(page, 240), e = await frame(page, 800), end = await frame(page, 2000);
  assert.notEqual(mid.logo, m.logo, 'The E starts turning in depth');
  assert.notEqual(mid.logo, e.logo, 'The rotation advances smoothly');
  assert.notEqual(end.logo, e.logo, 'The mark keeps rotating while startup waits');
  assert.deepEqual(m.centre, e.centre, 'The mark rotates about its centre');
  assert.ok(Math.abs(m.centre[0] - 640) < 1, 'The mark is centred in the window');
  assert.equal(await splash.locator('.splash-ribbon').count(), 0, 'No extra ribbon is added to the initial animation');
  assert.equal(await splash.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.effect.getTiming().iterations === Infinity)), true, 'The gyroscope stays animated until startup finishes');
  if (process.env.ELPIS_SPLASH_SHOTS) {
    await fs.mkdir(process.env.ELPIS_SPLASH_SHOTS, { recursive: true });
    for (const [name, ms] of [['0', 0], ['0.4', 400], ['0.8', 800], ['1.2', 1200], ['end', 2000]]) {
      await frame(page, ms);
      await page.screenshot({ path: path.join(process.env.ELPIS_SPLASH_SHOTS, `${colorScheme}-${name}.png`) });
    }
  }
});

test('reduced motion: startup keeps a slow, smooth rotation', async t => {
  const { page } = await starting(t, { colorScheme: 'dark', reducedMotion: 'reduce' });
  const splash = page.locator('.startup-splash');
  const rotor = splash.locator('.splash-logo');
  assert.equal(await rotor.evaluate(el => getComputedStyle(el).animationDuration), '12s');
  const first = await rotor.evaluate(el => getComputedStyle(el).transform);
  await page.waitForTimeout(160);
  assert.notEqual(await rotor.evaluate(el => getComputedStyle(el).transform), first, 'The animation remains visible');
  assert.equal(await rotor.evaluate(el => getComputedStyle(el).animationName), 'splash-gyro');
  if (process.env.ELPIS_SPLASH_SHOTS) await page.screenshot({ path: path.join(process.env.ELPIS_SPLASH_SHOTS, 'reduced-motion.png') });
  const before = await splash.innerHTML(); await page.waitForTimeout(140);
  assert.equal(await splash.innerHTML(), before, 'The slow rotation uses CSS');
});

test('the brief introduction fades and real mouse clicks pass through it', async t => {
  const { page, composer } = await starting(t, { failModels: true });
  await composer.evaluate(el => el.blur());
  const box = await composer.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.click(x, y);
  assert.equal(await composer.evaluate(el => el === document.activeElement), false, 'The pending splash covers the app');
  assert.equal(await page.locator('.startup-splash.leaving').count(), 0);
  await page.clock.runFor(450);
  const leaving = page.locator('.startup-splash.leaving');
  await leaving.waitFor({ state: 'attached' });
  const fade = await leaving.evaluate(el => ({ pointerEvents: getComputedStyle(el).pointerEvents, seconds: parseFloat(getComputedStyle(el).transitionDuration) }));
  assert.equal(fade.pointerEvents, 'none'); assert.ok(fade.seconds <= .3);
  await page.mouse.click(x, y); await page.keyboard.type('Draft during startup fade');
  assert.equal(await composer.inputValue(), 'Draft during startup fade');
  assert.equal(await leaving.count(), 1, 'The real click arrived while the fading splash was still mounted');
  await page.clock.runFor(300);
  assert.equal(await page.locator('.startup-splash').count(), 0, 'The brief splash is removed after its fade');
});
