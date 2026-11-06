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
