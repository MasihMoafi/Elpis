// Real packaged app and engine (tests/real-app.cjs): searching "main" puts the chat named main first, in the sidebar and in
// the Ctrl+K menu, even when 130 newer chats keep it out of the first page the app loaded (24 Oct: "I literally searched main
// and it didn't put main on top … Z does it"). Controlled chats only (tests/seed-chats.cjs).
// ELPIS_TEST_APP=/packaged/app ELPIS_TEST_ENGINE=$HOME/.local/bin/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=... [ELPIS_TEST_PORT=9445]
//   node --test tests/sidebar-search.runtime.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { seedChats } = require('./seed-chats.cjs');
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');

const ranked = ['main', 'main', 'Main branch cleanup', 'Hermes main setup', 'Domain notes', 'Release checklist'];

test('search ranks the chat named main first, in any letter case, past the loaded page, and clearing it restores the list', {
  skip: !process.env.ELPIS_TEST_APP || !process.env.ELPIS_TEST_ENGINE, timeout: 180000,
}, async t => {
  const seed = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/search-seed-'));
  seedChats(seed, [
    { key: 'main', name: 'main', text: 'Set up the repo', minutesAgo: 300 },
    { key: 'branch', name: 'Main branch cleanup', text: 'tidy the branches', minutesAgo: 200 },
    { key: 'hermes', name: 'Hermes main setup', text: 'configure hermes', minutesAgo: 190 },
    { key: 'domain', name: 'Domain notes', text: 'dns records', minutesAgo: 180 },
    { key: 'mention', name: 'Release checklist', text: 'merge into main tomorrow', minutesAgo: 170 },
    // An agent chat made by another chat; and a background run, which search leaves to the Agent runs list.
    { key: 'nested', name: 'main', text: 'nested helper chat', minutesAgo: 185, parentKey: 'hermes' },
    { key: 'run', name: 'main', text: 'sub agent run', minutesAgo: 186, subAgentOf: 'hermes' },
    { key: 'archived', name: 'main (archived)', text: 'old archived', minutesAgo: 400, archived: true },
    ...Array.from({ length: 130 }, (_, i) => ({ key: `filler-${i}`, name: `Filler chat ${i}`, text: `lorem ${i}`, minutesAgo: i + 1 })),
  ]);
  const running = await startApp({ app: process.env.ELPIS_TEST_APP, engine: process.env.ELPIS_TEST_ENGINE, port: Number(process.env.ELPIS_TEST_PORT || 9445), seed });
  t.after(() => stopApp(running));
  const { page } = running;
  await skipFirstRun(page);
  const titles = () => page.locator('aside.sidebar .thread-row .thread-title').allInnerTexts();
  await page.locator('aside.sidebar .thread-title', { hasText: 'Filler chat 0' }).first().waitFor({ timeout: 30000 });
  const search = page.getByLabel('Search conversations');
  const settled = async expected => {
    let shown = [];
    for (const until = Date.now() + 10000; Date.now() < until; await page.waitForTimeout(250)) {
      shown = await titles();
      if (JSON.stringify(shown.slice(0, expected.length)) === JSON.stringify(expected)) return shown;
    }
    return shown;
  };
  for (const term of ['main', 'MAIN', 'mai']) {
    await search.fill(term);
    const shown = await settled(ranked);
    assert.deepEqual(shown, ranked, `sidebar search for ${term}`);
  }
  await page.screenshot({ path: path.join(seed, 'sidebar-search.png') });
  await search.fill('');
  const restored = await settled(['Filler chat 0', 'Filler chat 1']);
  assert.deepEqual(restored.slice(0, 2), ['Filler chat 0', 'Filler chat 1'], 'clearing the search restores the list');
  assert.ok(!restored.includes('main (archived)'));

  await page.keyboard.press('Control+k');
  const menu = page.getByRole('dialog').last();
  await page.keyboard.type('main');
  let options = [];
  for (const until = Date.now() + 10000; Date.now() < until; await page.waitForTimeout(250)) {
    options = (await menu.getByRole('option').allInnerTexts()).map(text => text.split('\n')[0]);
    if (options[0] === 'main' && options.includes('Domain notes')) break;
  }
  assert.deepEqual(options.slice(0, ranked.length), ranked, 'the Ctrl+K menu ranks as the sidebar does');
  await page.screenshot({ path: path.join(seed, 'command-menu-search.png') });
  await page.keyboard.press('Escape');
});
