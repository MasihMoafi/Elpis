// The Elpis symbol rotates upright without the extra ribbon, in both themes.
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

/** Seek the actual CSS motion rather than waiting for approximate wall-clock frames. */
const frame = (page, ms) => page.evaluate(ms => {
  for (const animation of document.querySelector('.startup-splash').getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = ms; }
  const logo = document.querySelector('.splash-logo'), box = logo.getBoundingClientRect();
  const transform = getComputedStyle(logo).transform;
  const [a, b] = transform === 'none' ? [1, 0] : transform.match(/matrix\(([^)]+)\)/)[1].split(',').map(Number);
  const trail = document.querySelector('.splash-ribbon path');
  return { logo: Math.round(Math.atan2(b, a) * 180 / Math.PI), centre: [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)],
    ribbon: trail && { offset: parseFloat(getComputedStyle(trail).strokeDashoffset), opacity: Number(getComputedStyle(trail).opacity) } };
}, ms);

for (const colorScheme of ['light', 'dark']) test(`startup: symbol rotates upright without an added ribbon (${colorScheme})`, async t => {
  const { page } = await starting(t, { colorScheme });
  const splash = page.locator('.startup-splash');
  const logo = page.locator('.splash-logo');
  assert.match(await logo.getAttribute('src'), /\/branding\/elpis-symbol-amber\.svg$/);
  await page.waitForFunction(() => document.querySelector('.splash-logo')?.naturalWidth > 0);
  assert.equal(await splash.locator('.splash-dial, .splash-ticks, .splash-arcs, .splash-hex, .splash-scope, .splash-sweep, .splash-boot-panel, .splash-boot, .splash-meter').count(), 0, 'No HUD parts remain');
  const ground = await splash.evaluate(el => ({ background: getComputedStyle(el).backgroundColor,
    before: getComputedStyle(el, '::before').backgroundImage, after: getComputedStyle(el, '::after').backgroundImage }));
  assert.equal(ground.background, 'rgb(10, 11, 13)', 'The brand opening stays dark even when the app theme is light');
  assert.doesNotMatch(ground.before + ground.after, /repeating-linear-gradient/, 'No HUD floor grid remains');
  const m = await frame(page, 0), mid = await frame(page, 240), e = await frame(page, 800), end = await frame(page, 2000);
  assert.equal(m.logo, 90, 'The first frame is the M');
  assert.ok(mid.logo > 0 && mid.logo < 90, `A real quarter turn between M and E: ${mid.logo}°`);
  assert.equal(e.logo, 0, 'The final mark is the upright Elpis E');
  assert.equal(end.logo, 0, 'The E stays upright while startup waits');
  assert.deepEqual(m.centre, e.centre, 'The mark rotates about its centre');
  assert.ok(Math.abs(m.centre[0] - 640) < 1, 'The mark is centred in the window');
  assert.equal(await splash.locator('.splash-ribbon').count(), 0, 'No extra ribbon is added to the initial animation');
  assert.equal(await splash.evaluate(el => el.getAnimations({ subtree: true }).some(animation => animation.effect.getTiming().iterations === Infinity)), false, 'App startup plays once');
  if (process.env.ELPIS_SPLASH_SHOTS) {
    await fs.mkdir(process.env.ELPIS_SPLASH_SHOTS, { recursive: true });
    for (const [name, ms] of [['0', 0], ['0.4', 400], ['0.8', 800], ['1.2', 1200], ['end', 2000]]) {
      await frame(page, ms);
      await page.screenshot({ path: path.join(process.env.ELPIS_SPLASH_SHOTS, `${colorScheme}-${name}.png`) });
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
  release('/api/threads');
  await page.locator('.startup-splash.leaving').waitFor({ state: 'attached' });
});

test('reduced motion: nothing on the startup splash moves and the E stays upright', async t => {
  const { page } = await starting(t, { colorScheme: 'dark', reducedMotion: 'reduce' });
  const splash = page.locator('.startup-splash');
  assert.equal(await splash.evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'Reduced motion must stop all splash animation');
  assert.equal(await page.locator('.splash-logo').evaluate(el => getComputedStyle(el).transform), 'none');
  if (process.env.ELPIS_SPLASH_SHOTS) await page.screenshot({ path: path.join(process.env.ELPIS_SPLASH_SHOTS, 'reduced-motion.png') });
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
