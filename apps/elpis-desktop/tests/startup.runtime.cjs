// Real packaged app and engine (tests/real-app.cjs). Startup as Masih meets it (24 Oct: "startup animation was fixed and you
// reverted it"): the startup screen wears the saved theme from its first frame; the window opens and is usable without
// waiting for the background service, also when that service is slow or missing; a restart keeps the chat and its draft.
// ELPIS_TEST_APP=/packaged/app ELPIS_TEST_ENGINE=$HOME/.local/bin/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=... [ELPIS_TEST_PORT=9446]
//   node --test tests/startup.runtime.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { realpathSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedChats } = require('./seed-chats.cjs');
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');

const app = process.env.ELPIS_TEST_APP, engine = process.env.ELPIS_TEST_ENGINE, port = Number(process.env.ELPIS_TEST_PORT || 9446);
const skip = !app || !engine;
const scratch = prefix => fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests', prefix));
async function seed() {
  const dir = await scratch('startup-seed-');
  seedChats(dir, [{ key: 'old', name: 'Older chat', text: 'an older question', minutesAgo: 60 }, { key: 'release', name: 'Release checklist', text: 'merge into main tomorrow', minutesAgo: 30 }]);
  return dir;
}
async function profile(values = {}) {
  const dir = await scratch('startup-profile-');
  await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify(values));
  return dir;
}
/** The installed engine behind a background service that starts `delay` ms late. */
async function slowEngine(delay) {
  const real = realpathSync(engine), root = path.resolve(path.dirname(real), '../..'), dir = await scratch('slow-engine-');
  await fs.mkdir(path.join(dir, 'package/bin'), { recursive: true }); await fs.mkdir(path.join(dir, 'tools/elpis-claude'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package/bin/codex'), `#!/bin/sh\nexec ${JSON.stringify(real)} "$@"\n`, { mode: 0o755 });
  for (const name of await fs.readdir(path.join(root, 'tools/elpis-claude'))) if (name !== 'shared-runtime.mjs') await fs.symlink(path.join(root, 'tools/elpis-claude', name), path.join(dir, 'tools/elpis-claude', name));
  const helper = path.join(root, 'tools/elpis-claude/shared-runtime.mjs');
  await fs.writeFile(path.join(dir, 'tools/elpis-claude/shared-runtime.mjs'), `await new Promise(resolve => setTimeout(resolve, ${delay}));\nprocess.argv[1] = ${JSON.stringify(helper)};\nawait import(process.argv[1]);\n`);
  return path.join(dir, 'package/bin/codex');
}
const row = (page, title) => page.locator('aside.sidebar .thread-row', { has: page.locator('.thread-title', { hasText: title }) }).first();

for (const [theme, colour] of [['light', 'rgb(251, 251, 250)'], ['dark', 'rgb(10, 11, 13)']]) test(`the startup screen is ${theme} from its first frame when the app is ${theme}`, { skip, timeout: 120000 }, async t => {
  const running = await startApp({ app, engine, port, seed: await seed(), profile: await profile({ 'elpis-theme': theme }) });
  t.after(() => stopApp(running));
  const { page } = running;
  // Every colour the startup screen shows, from the document's first parse, through a reload of the same window.
  await page.addInitScript(() => {
    const seen = window.__splash = [];
    new MutationObserver(() => { const splash = document.querySelector('.startup-splash'); if (splash) { const colour = getComputedStyle(splash).backgroundColor; if (seen.at(-1) !== colour) seen.push(colour); } })
      .observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  const reloaded = Date.now();
  await page.reload({ waitUntil: 'commit' });
  await page.locator('.startup-splash').waitFor({ state: 'attached', timeout: 4000 });
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 4000 });
  const gone = Date.now() - reloaded;
  assert.deepEqual(await page.evaluate(() => window.__splash), [colour], `the ${theme} app showed a startup screen in other colours`);
  assert.ok(gone < 2500, `the startup screen stayed ${gone} ms`);
  await page.screenshot({ path: path.join(running.home, `startup-${theme}.png`) });
});

test('a slow background service never holds the window: it opens at once, and chats arrive with the service', { skip, timeout: 150000 }, async t => {
  const running = await startApp({ app, engine: await slowEngine(20000), port, seed: await seed(), profile: await profile({ 'elpis-theme': 'light' }) });
  t.after(() => stopApp(running));
  const { page } = running;
  assert.ok(running.windowMs < 10000, `the window took ${running.windowMs} ms`);
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 4000 });
  await page.getByRole('status').filter({ hasText: /Connecting to Elpis|disconnected/ }).first().waitFor();
  await skipFirstRun(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'General', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  const refusals = () => page.getByRole('alert').filter({ hasText: /ELPIS_RUNTIME_UNAVAILABLE|disconnected/ }).allInnerTexts();
  assert.deepEqual(await refusals(), [], 'while it starts, the connection line speaks for it; no error banners');
  await row(page, 'Release checklist').waitFor({ timeout: 60000 });
  assert.equal((await page.evaluate(() => fetch('/api/health').then(response => response.json()))).connected, true);
  await page.waitForTimeout(1000);
  assert.deepEqual(await refusals(), [], 'nothing stale once it is there');
  await page.screenshot({ path: path.join(running.home, 'slow-service-arrived.png') });
});

test('a missing background service opens the window and keeps the reason', { skip, timeout: 120000 }, async t => {
  const running = await startApp({ app, engine: path.join(os.tmpdir(), 'no-elpis-here/elpis-next'), port, profile: await profile({ 'elpis-theme': 'light' }) });
  t.after(() => stopApp(running));
  const { page } = running;
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 4000 });
  await page.getByRole('status').filter({ hasText: /Connecting to Elpis|disconnected/ }).first().waitFor();
  const health = await page.evaluate(() => fetch('/api/health').then(response => response.json()));
  assert.equal(health.connected, false); assert.match(health.error, /could not be found/);
});

test('a restart reopens the selected chat with its unsent draft', { skip, timeout: 150000 }, async t => {
  const chats = await seed(), saved = await profile({ 'elpis-theme': 'light' }), draft = `draft kept across a restart ${Date.now()}`;
  let running = await startApp({ app, engine, port, seed: chats, profile: saved });
  t.after(() => stopApp(running));
  await skipFirstRun(running.page);
  await row(running.page, 'Release checklist').click();
  const composer = page => page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await composer(running.page).fill(draft);
  await running.page.waitForTimeout(1500);
  await stopApp(running);
  running = await startApp({ app, engine, port, seed: chats, profile: saved });
  const { page } = running;
  await page.locator('aside.sidebar .thread-row.active .thread-title', { hasText: 'Release checklist' }).waitFor({ timeout: 30000 });
  await page.waitForFunction(text => document.querySelector('textarea[aria-label="Message Elpis"], [aria-label="Message Elpis"]')?.value === text, draft, { timeout: 15000 });
  assert.equal(await composer(page).inputValue(), draft);
});
