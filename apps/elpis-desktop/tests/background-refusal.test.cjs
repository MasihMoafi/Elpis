// 5 Nov, Masih, under a red "Error: Elpis is temporarily unavailable. Try again in a moment. (ELPIS_RUNTIME_ERROR; request
// …)" bar: "this error doesn't even need to show. it's non-existent and meaningless. the chat was loaded when this error
// showed." Reads the app makes on its own (re-reading the open chat, listing its agents) retry quietly; a chat that cannot
// be shown at all still says so.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

const shown = '00000000-0000-4000-8000-0000000000b1', broken = '00000000-0000-4000-8000-0000000000b2';

test('a chat on screen gets no error bar when the engine refuses a background read; a chat that cannot load still reports it', async () => {
  const { BridgeError } = await import('../bridge/validate.mjs');
  const refusal = () => Object.assign(new BridgeError('Elpis rejected the operation (-32600). No automatic retry was made.', 502), { code: -32600 });
  const reads = { [shown]: 0, [broken]: 0 };
  let f;
  f = await loveSpotFixture({ configureClient: client => {
    // The first read of the shown chat succeeds; every later one, and every read of the broken chat, is refused.
    const hello = { threadId: shown, turnId: 't1', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Hello there' }] } };
    client.readThread = async id => {
      reads[id] = (reads[id] ?? 0) + 1; if (id === broken || reads[id] > 1) throw refusal();
      return { thread: f.chats.find(chat => chat.id === id), data: [hello], nextCursor: null };
    };
    client.resume = async () => { throw refusal(); }; // The chat cannot be followed live, so the app re-reads it every 3 s.
    const list = client.listThreads;
    client.listThreads = async (options = {}) => { if (options.ancestorThreadId) throw refusal(); return list(options); };
  } });
  try {
    const { page } = f;
    const chat = (id, name) => ({ id, name, preview: name, cwd: f.directory, modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } });
    f.chats.push(chat(shown, 'Loaded chat'), chat(broken, 'Unreadable chat'));
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const bar = page.locator('.error-banner[role="alert"]');

    await page.locator(`aside [data-thread-id="${shown}"] .thread-link`).click();
    await page.locator('.message').filter({ hasText: 'Hello there' }).first().waitFor()
      .catch(async e => { throw new Error(`${e.message}\nreads ${JSON.stringify(reads)}; api: ${f.responses.filter(r => r.url.includes('/api/') && !r.url.includes('love-spot')).map(r => `${r.status} ${new URL(r.url).pathname}${new URL(r.url).search}`).join(' | ')}; main: ${(await page.locator('main').innerText()).slice(0, 600)}`); });
    // Two background re-reads (every 3 s), each refused by the engine.
    const end = Date.now() + 15000; while (reads[shown] < 3 && Date.now() < end) await page.waitForTimeout(250);
    assert.ok(reads[shown] >= 3, `the app re-read the open chat in the background (${reads[shown]} reads)`);
    assert.equal(await bar.count(), 0, `no error bar over a loaded chat: ${await bar.allInnerTexts()}`);
    assert.ok(await page.locator('.message').filter({ hasText: 'Hello there' }).first().isVisible(), 'the chat stays on screen');

    // Negative: a chat with nothing to show still says it could not load.
    await page.locator(`aside [data-thread-id="${broken}"] .thread-link`).click();
    await bar.waitFor();
    assert.match(await bar.innerText(), /temporarily unavailable/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
