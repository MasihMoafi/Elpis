const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');

// Hold the real renderer's health response so the splash is observable without a runtime.
async function starting(t, colorScheme = 'light', reducedMotion = 'no-preference', freezeTime = false) {
  const f = await fixture({ width: 1280, height: 900, colorScheme });
  let release;
  t.after(async () => { release?.(); await f.close(); assert.deepEqual(f.errors, []); });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  await f.page.emulateMedia({ reducedMotion });
  const time = new Date();
  await f.page.clock.install({ time });
  if (freezeTime) await f.page.clock.pauseAt(new Date(time.getTime() + 1000));
  const health = new Promise(resolve => { release = resolve; });
  await f.page.route('**/api/health', async route => { await health; await route.fulfill({ json: { connected: true } }); });
  // A failed model catalogue must not prevent the readiness signal from dismissing the splash.
  await f.page.route('**/api/models', route => route.fulfill({ status: 503, json: { error: 'Fixture catalogue unavailable' } }));
  await f.page.reload({ waitUntil: 'domcontentloaded' });
  await f.page.locator('.startup-splash').waitFor();
  return { ...f, release };
}

for (const colorScheme of ['light', 'dark']) test(`startup shows the old amber hexagon and send mark, centred on the app (${colorScheme})`, async t => {
  const { page } = await starting(t, colorScheme);
  const hex = page.locator('.splash-hex');
  assert.equal(await hex.count(), 1, 'The old send-button hexagon replaces the terminal logo');
  assert.equal(await hex.locator('svg path').count(), 1, 'Reuse the existing send mark');
  assert.equal(await page.locator('.startup-splash').innerText(), 'Elpis');
  const geometry = await hex.evaluate(el => {
    const rect = el.getBoundingClientRect(), splash = el.closest('.startup-splash');
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, nameY: splash.querySelector('p').getBoundingClientRect().top,
      background: getComputedStyle(splash).backgroundColor, appBackground: getComputedStyle(document.body).backgroundColor,
      amber: getComputedStyle(el, '::before').backgroundColor, mark: getComputedStyle(el).color };
  });
  assert.equal(geometry.x, 640); assert.ok(Math.abs(geometry.y - 450) < 45); assert.ok(geometry.nameY > geometry.y);
  assert.equal(geometry.background, geometry.appBackground);
  assert.equal(geometry.amber, 'rgb(242, 169, 59)'); assert.equal(geometry.mark, 'rgb(22, 13, 2)');
  const transform = () => hex.evaluate(el => getComputedStyle(el, '::before').transform);
  const before = await transform(); await page.waitForTimeout(140); assert.notEqual(await transform(), before, 'The hexagon turns while startup is pending');
  if (process.env.ELPIS_SPLASH_SHOTS) {
    await fs.mkdir(process.env.ELPIS_SPLASH_SHOTS, { recursive: true });
    for (const [index, time] of [0, 1500, 3000].entries()) {
      await page.evaluate(time => { for (const animation of document.querySelector('.splash-hex').getAnimations({ subtree: true })) { animation.pause(); animation.currentTime = time; } }, time);
      await page.screenshot({ path: path.join(process.env.ELPIS_SPLASH_SHOTS, `${colorScheme}-${index + 1}.png`) });
    }
  }
});

test('reduced motion leaves the startup hexagon and send mark still', async t => {
  const { page } = await starting(t, 'dark', 'reduce');
  const splash = page.locator('.startup-splash');
  assert.equal(await splash.evaluate(el => el.getAnimations({ subtree: true }).length), 0, 'Reduced motion must stop all splash animation');
  const before = await splash.innerHTML(); await page.waitForTimeout(140);
  assert.equal(await splash.innerHTML(), before, 'No JavaScript colour sweep continues in reduced motion');
  assert.equal(await page.locator('.splash-hex').count(), 1);
});

test('readiness starts a short fade immediately and real mouse clicks pass through it', async t => {
  const { page, composer, release } = await starting(t, 'light', 'no-preference', true);
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
