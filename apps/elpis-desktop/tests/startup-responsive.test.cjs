// A busy or disconnected bridge must never hide local navigation or prevent drafting.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');

for (const pending of ['threads', 'settings', 'health', 'restored chat', 'session', 'session last chat', 'unreachable', 'rejected']) test(`startup opens within two seconds with ${pending} pending`, async t => {
  const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme: pending === 'unreachable' ? 'light' : 'dark' });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(async () => { release(); await f.close(); assert.deepEqual(f.errors, []); });
  const waitingForSession = pending.startsWith('session');
  if (pending === 'session last chat') {
    await f.open('chat-a');
    await f.page.waitForFunction(() => window.elpisDesktop.storage.getItem('elpis-last-chat') === 'chat-a');
    await f.page.evaluate(() => window.elpisDesktop.storage.removeItem('elpis-chat-tabs-v1'));
  }
  const held = waitingForSession ? '/api/session' : pending === 'threads' ? '/api/threads' : pending === 'settings' ? '/api/settings' : pending === 'restored chat' ? '/api/threads/chat-a' : '/api/health';
  const requested = [], sent = [];
  await f.page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    requested.push(pathname);
    if (route.request().method() === 'POST' && /^\/api\/threads(?:\/[^/]+\/(?:turns|steer|shell|side-chat|compact))?$/.test(pathname)) sent.push(pathname);
    if (pending === 'rejected' && pathname === '/api/health') return route.fulfill({ status: 503, json: { error: 'Bridge unavailable' } });
    if (pending === 'rejected' && pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'event: connection\ndata: {"connected":false}\n\n' });
    if (pathname === held || (pending === 'unreachable' && pathname === '/api/events')) await gate;
    await route.fallback();
  });
  await f.page.goto(new URL(pending === 'session' ? '/?session=chat-a#token=fixture' : pending === 'session last chat' ? '/?boot=session-last#token=fixture' : pending === 'restored chat' ? '/?session=chat-a' : '/', f.page.url()).href, { waitUntil: 'domcontentloaded' });
  await f.page.locator('.startup-splash').waitFor({ state: 'visible' });
  await f.page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 2000 });
  if (waitingForSession || pending === 'unreachable' || pending === 'rejected') {
    await f.composer.fill('Draft before Elpis connects', { timeout: 1000 });
    await f.composer.press('Enter');
    assert.equal(await f.composer.inputValue(), 'Draft before Elpis connects');
    assert.equal(await f.page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true, 'Only sending needs a connection');
    assert.deepEqual(sent, [], 'offline Enter never creates a chat or sends a turn');
    await f.page.getByRole('status').filter({ hasText: /Connecting to Elpis|Elpis is disconnected/ }).waitFor();
  } else {
    await f.composer.fill('Draft while data loads', { timeout: 1000 });
    assert.equal(await f.composer.inputValue(), 'Draft while data loads');
  }
  if (process.env.ELPIS_BOOT_SHOTS && ['threads', 'unreachable'].includes(pending)) {
    await fs.mkdir(process.env.ELPIS_BOOT_SHOTS, { recursive: true });
    await f.page.screenshot({ path: `${process.env.ELPIS_BOOT_SHOTS}/boot-${pending === 'threads' ? 'dark-loading' : 'light-offline'}.png` });
  }
  await f.page.getByRole('button', { name: 'Settings', exact: true }).click({ timeout: 1000 });
  await f.page.getByRole('heading', { name: 'General', exact: true }).waitFor();
  assert.ok(requested.includes(held) || pending === 'health', 'The blocked data request was reached');
  release();
  await f.page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').first().waitFor();
  if (waitingForSession) {
    await f.page.locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
    await f.page.getByRole('button', { name: 'Send message', exact: true }).waitFor({ state: 'visible' });
    await f.page.waitForFunction(() => !document.querySelector('button[aria-label="Send message"]').disabled);
    assert.equal(await f.composer.inputValue(), 'Draft before Elpis connects', 'restoring the requested or last chat cannot displace the text typed during connection setup');
    assert.deepEqual(sent, [], 'connecting never replays the early draft');
  }
  if (pending === 'threads') {
    await f.open('chat-a');
    assert.equal(await f.shown(), 'chat-a', 'Conversations arrive and open after the delay');
  }
});

// 24 Oct: the window now opens before the background service. Reads refused while it starts must not stay on screen as
// errors once it is there; the connection line says what is happening meanwhile.
test('a background service that arrives late leaves no disconnection errors behind', async t => {
  const f = await fixture({ desktop: true, width: 1440, height: 900, colorScheme: 'light' });
  t.after(async () => { await f.close(); });
  let up = false;
  const refused = { status: 503, json: { error: 'Elpis is disconnected', code: 'ELPIS_RUNTIME_UNAVAILABLE', requestId: 'test-request' } };
  await f.page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!up && pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: 'retry: 200\nevent: connection\ndata: {"connected":false}\n\n' });
    if (!up && pathname === '/api/health') return route.fulfill({ json: { connected: false } });
    if (!up && ['/api/threads', '/api/models', '/api/settings'].includes(pathname)) return route.fulfill(refused);
    await route.fallback();
  });
  await f.page.goto(new URL('/', f.page.url()).href, { waitUntil: 'domcontentloaded' });
  await f.page.getByRole('status').filter({ hasText: /Connecting to Elpis|disconnected/ }).first().waitFor();
  await f.page.waitForTimeout(800);
  assert.deepEqual(await f.page.getByRole('alert').filter({ hasText: /ELPIS_RUNTIME_UNAVAILABLE/ }).allInnerTexts(), [], 'the connection line already says Elpis is not there yet');
  up = true;
  await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').first().waitFor({ timeout: 10000 });
  await f.page.waitForTimeout(500);
  assert.deepEqual(await f.page.getByRole('alert').filter({ hasText: /ELPIS_RUNTIME_UNAVAILABLE|disconnected/ }).allInnerTexts(), [], 'nothing stale remains once Elpis is there');
});
