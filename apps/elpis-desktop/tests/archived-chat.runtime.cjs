// Real packaged app and engine (tests/real-app.cjs): an archived chat (Love Spot's own was archived in a sweep, 24 Oct) opens
// without the engine's "Run `codex unarchive …`" error, and writing in it brings it back to the chat list and sends
// (24 Oct: "this is inside of Elpis; there is no codex inside of Elpis!"). Controlled chats only (tests/seed-chats.cjs).
// ELPIS_TEST_APP=/packaged/app ELPIS_TEST_ENGINE=$HOME/.local/bin/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=... [ELPIS_TEST_PORT=9447]
//   node --test tests/archived-chat.runtime.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { seedChats } = require('./seed-chats.cjs');
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');

test('an archived chat opens without an error; a message in it brings it back and is sent; no error names codex', {
  skip: !process.env.ELPIS_TEST_APP || !process.env.ELPIS_TEST_ENGINE, timeout: 180000,
}, async t => {
  const seed = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/archived-seed-'));
  const ids = seedChats(seed, [
    { key: 'kept', name: 'Kept chat', text: 'still here', minutesAgo: 10 },
    { key: 'love', name: 'Love Spot', text: 'hello Matilda', minutesAgo: 20, archived: true },
  ]);
  const running = await startApp({ app: process.env.ELPIS_TEST_APP, engine: process.env.ELPIS_TEST_ENGINE, port: Number(process.env.ELPIS_TEST_PORT || 9447), seed });
  t.after(() => stopApp(running));
  const { page } = running;
  await skipFirstRun(page);
  const titles = () => page.locator('aside.sidebar .thread-row .thread-title').allInnerTexts();
  await page.locator('aside.sidebar .thread-title', { hasText: 'Kept chat' }).first().waitFor({ timeout: 30000 });
  assert.equal((await titles()).includes('Love Spot'), false, 'the archived chat starts outside the list');
  // The window's own calls, as Love Spot and an opened tab make them.
  const call = (route, body) => page.evaluate(async ([route, body]) => {
    const response = await fetch(`/api${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, [route, body]);
  const opened = await call(`/threads/${ids.love}/resume`, {});
  assert.equal(opened.status, 200, `opening the archived chat failed: ${JSON.stringify(opened.body)}`);
  assert.equal(opened.body.thread.id, ids.love);
  assert.equal((await titles()).includes('Love Spot'), false, 'opening it leaves it archived');
  const sent = await call(`/threads/${ids.love}/turns`, { text: 'Hello again' });
  assert.doesNotMatch(JSON.stringify(sent.body), /codex|is archived/i, 'the message reaches the chat');
  assert.equal(sent.status, 200, `sending failed: ${JSON.stringify(sent.body)}`);
  await page.locator('aside.sidebar .thread-title', { hasText: 'Love Spot' }).first().waitFor({ timeout: 15000 });
  let shown = '';
  for (let tries = 0; tries < 20 && !/Hello again/.test(shown); tries++) {
    if (tries) await new Promise(resolve => setTimeout(resolve, 500));
    shown = JSON.stringify((await page.evaluate(async id => (await fetch(`/api/threads/${id}?limit=20`)).json(), ids.love)).data ?? null);
  }
  assert.match(shown, /Hello again/, `the message is in the chat; it shows ${shown.slice(0, 600)}`);
});
