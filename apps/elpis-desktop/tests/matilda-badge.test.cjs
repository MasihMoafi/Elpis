const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

// 30 Oct (C7): "the unread badge clears once he has read it". An answer he reads in Matilda's small chat is read.
for (const colorScheme of ['light', 'dark']) test(`an answer read in her small chat leaves no unread badge on Love Spot (${colorScheme})`, { timeout: 90000 }, async t => {
  const f = await loveSpotFixture({ colorScheme, reply: 'Here is my answer, love.', replyDelay: 500 });
  t.after(() => f.close());
  const page = f.page;
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator('.app-menus').waitFor();
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  const presence = page.getByRole('region', { name: 'Pinned Matilda', exact: true }); await presence.waitFor();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true });
  await presence.getByRole('button', { name: 'Chat with Matilda', exact: true }).click(); await mini.waitFor();
  await mini.getByRole('textbox', { name: 'Message Matilda', exact: true }).fill('How are you?');
  await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await mini.getByText('Here is my answer, love.', { exact: true }).waitFor({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const evidence = path.join(process.env.ELPIS_SHOTS || require('node:os').tmpdir(), `matilda-badge-${colorScheme}.png`);
  await page.screenshot({ path: evidence });
  assert.equal(await page.locator('.love-unread').count(), 0, 'he read her answer in her small chat: no unread badge');
  assert.equal(await page.locator('aside .thread-dot[data-state="unread"]').count(), 0, 'and no unread dot on her row in the sidebar');
  await page.keyboard.press('Escape'); await mini.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.love-unread').count(), 0, 'and it does not come back after the chat closes');
  assert.equal(await page.locator('aside .thread-dot[data-state="unread"]').count(), 0, 'nor does the dot on her row');
  assert.deepEqual(f.errors, []);
});

for (const first of ['stream', 'send']) test(`a reply stays visible when ${first} beats the first conversation read`, { timeout: 60000 }, async t => {
  const f = await loveSpotFixture({ reply: 'Here is my answer, love.', replyDelay: 200 });
  let release = () => {};
  t.after(async () => { release(); await f.close(); });
  const page = f.page;
  const nextReply = () => new Promise(resolve => {
    const onEvent = event => {
      if (event.data?.method === 'turn/completed') { f.emitter.off('event', onEvent); resolve(); }
    };
    f.emitter.on('event', onEvent);
  });
  const oldReply = nextReply();
  const seed = await page.evaluate(async () => {
    const response = await fetch('/api/love-spot/talk', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'An old question' }) });
    return { ok: response.ok, status: response.status };
  });
  assert.equal(seed.ok, true, `seed request: ${seed.status}`);
  await oldReply;
  let readStarted, streamStarted;
  const waiting = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { readStarted = resolve; });
  const stream = new Promise(resolve => { streamStarted = resolve; });
  await page.route('**/api/love-spot/talk', async route => {
    if (route.request().method() === 'GET') {
      readStarted();
      await waiting;
    }
    await route.continue();
  });
  if (first === 'send') await page.route('**/api/love-spot/talk/events', async route => {
    streamStarted();
    await waiting;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  await page.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true });
  await started;
  if (first === 'stream') await mini.getByText('An old question', { exact: true }).waitFor();
  else await stream;
  const completed = nextReply();
  await mini.getByRole('textbox', { name: 'Message Matilda', exact: true }).fill('How are you?');
  await mini.getByRole('button', { name: 'Send to Matilda', exact: true }).click();
  await mini.getByText('How are you?', { exact: true }).waitFor({ timeout: 5000 });
  await completed;
  release();
  await mini.getByText('Here is my answer, love.', { exact: true }).last().waitFor({ timeout: 5000 });
  assert.equal(await mini.getByText('How are you?', { exact: true }).count(), 1);
  // 31 Oct: the last earlier messages show at once, without a button.
  await mini.getByText('An old question', { exact: true }).waitFor();
  assert.deepEqual(f.errors, []);
});
