// 6 Nov, Masih: "the read aloud option via kokoro which I even chose a favorite voice hasn't been implemented". A reply's
// Read aloud is voiced by local Kokoro (bridge/kokoro.mjs) piece by piece, without Markdown or addresses; without Kokoro
// the action does not show (SPEC 45: no hidden paid fallback).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

/** A short silent WAV, as the bridge returns. */
function silentWav(seconds = 0.3, rate = 24000) {
  const samples = Math.round(seconds * rate), data = Buffer.alloc(samples * 2), header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

for (const available of [true, false]) test(`Read aloud ${available ? 'voices a reply with local Kokoro, piece by piece' : 'does not show without Kokoro'}`, async () => {
  const f = await fixture(), voiced = [];
  try {
    await f.page.route('**/api/read-aloud', async route => {
      if (route.request().method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available }) });
      voiced.push(JSON.parse(route.request().postData()).text);
      return route.fulfill({ contentType: 'audio/wav', body: silentWav() });
    });
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.open('chat-a');
    const reply = f.page.locator('.message.agent').filter({ hasText: 'two passes' }).first();
    await reply.hover();
    const read = reply.getByRole('button', { name: 'Read aloud', exact: true });
    if (!available) { await f.page.waitForTimeout(500); assert.equal(await read.count(), 0); assert.deepEqual(voiced, []); return; }
    await read.click();
    await reply.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    const end = Date.now() + 10000; while (Date.now() < end && !(await read.count())) await f.page.waitForTimeout(100);
    assert.ok(await read.count(), 'Read aloud comes back once the reply has been read');
    assert.deepEqual(voiced, ['The parser has two passes. lexing parsing See the guide.'], 'one piece, without Markdown marks or the address');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
