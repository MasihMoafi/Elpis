const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { LOGO_ACCENT: accent, openSettings, unapprovedOranges } = require('./controls.cjs');
const { contrastFailures } = require('./hud-contrast.cjs');

for (const colorScheme of ['light', 'dark']) test(`A87 Send matches the approved logo asset (${colorScheme})`, async t => {
  const f = await fixture({ colorScheme, width: 1280, height: 900, routes: {
    '/api/settings': () => ({ main: { model: 'sol', provider: 'openai' }, providers: [{ id: 'openai', displayName: 'OpenAI' }], write: { available: false } }),
  } });
  t.after(async () => { await f.close(); assert.deepEqual(f.errors, []); });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  await f.composer.fill('Logo accent check');
  const paint = await f.page.locator('.send-button').evaluate((element, accent) => {
    const probe = document.createElement('span'); probe.style.color = accent; document.body.append(probe);
    const expected = getComputedStyle(probe).color; probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, expected };
  }, accent);
  assert.equal(paint.actual, paint.expected, `Send differs from the logo's main colour ${accent}`);
  const directory = process.env.ELPIS_A87_SHOTS;
  async function check(screen) {
    if (screen === 'new-chat') await f.page.waitForTimeout(1100); // Let the logo's existing letter arrival finish.
    assert.deepEqual(await f.page.evaluate(contrastFailures), [], `${screen}: readable text`);
    if (colorScheme === 'light') assert.deepEqual(await unapprovedOranges(f.page), [], `${screen}: one approved accent`);
    if (directory) {
      await fs.mkdir(directory, { recursive: true });
      await f.page.screenshot({ path: path.join(directory, `${screen}-${colorScheme}.png`) });
    }
  }
  await check('new-chat');
  await f.open('chat-a');
  await f.page.locator('.message.agent a').first().scrollIntoViewIfNeeded();
  await check('chat');
  await f.page.reload();
  await f.open('chat-a');
  assert.equal(await f.page.locator('.send-button').evaluate(element => getComputedStyle(element).backgroundColor), paint.expected, 'reload keeps the logo colour');
  await openSettings(f.page);
  await f.page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await check('settings');
});
