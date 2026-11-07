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
  const f = await fixture(), voiced: string[] = [];
  try {
    await f.page.route('**/api/read-aloud', async (route: { request(): { method(): string; postData(): string }; fulfill(options: { contentType: string; body: string | Buffer }): Promise<unknown> }) => {
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

for (const action of ['toolbar', 'more menu', 'context menu']) test(`Read aloud uses the selected passage through the ${action}, then the full reply without a selection`, async () => {
  const f = await fixture(), voiced: string[] = [];
  try {
    await f.page.route('**/api/read-aloud', async (route: { request(): { method(): string; postData(): string }; fulfill(options: { contentType: string; body: string | Buffer }): Promise<unknown> }) => {
      if (route.request().method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: true }) });
      voiced.push(JSON.parse(route.request().postData()).text);
      return route.fulfill({ contentType: 'audio/wav', body: silentWav() });
    });
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' }); await f.open('chat-a');
    const reply = f.page.locator('.message.agent').filter({ hasText: 'two passes' }).first();
    const words = reply.locator('strong').first(); await words.scrollIntoViewIfNeeded(); const box = await words.boundingBox();
    await f.page.mouse.move(box.x + 1, box.y + box.height / 2); await f.page.mouse.down();
    await f.page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 }); await f.page.mouse.up();
    assert.equal(await f.page.evaluate(() => getSelection()!.toString()), 'two passes'); await f.page.keyboard.press('Escape');
    const invoke = async () => {
      if (action === 'toolbar') await reply.getByRole('button', { name: 'Read aloud', exact: true }).click();
      else {
        if (action === 'more menu') await reply.getByRole('button', { name: 'More message actions' }).click();
        else { const area = await reply.boundingBox(); await f.page.mouse.click(area.x + area.width - 3, box.y + box.height / 2, { button: 'right' }); }
        if (!voiced.length) await f.page.evaluate(() => getSelection()!.removeAllRanges());
        await f.page.getByRole('menuitem', { name: 'Read aloud', exact: true }).click();
      }
      await reply.getByRole('button', { name: 'Stop', exact: true }).waitFor();
      await reply.getByRole('button', { name: 'Read aloud', exact: true }).waitFor();
    };
    await invoke(); assert.deepEqual(voiced, ['two passes']);
    await f.page.evaluate(() => getSelection()!.removeAllRanges()); await invoke();
    assert.deepEqual(voiced, ['two passes', 'The parser has two passes. lexing parsing See the guide.']);
  } finally { await f.close(); }
});

for (const selected of ['x'.repeat(3799) + '😀', 'hello world '.repeat(60) + 'x_y']) test(`Read aloud preserves long selected text (${selected.length} UTF-16 units)`, async () => {
  const f = await fixture({ chat: [['t1', 'Explain.', selected]] }), voiced: string[] = [];
  try {
    await f.page.route('**/api/read-aloud', async (route: { request(): { method(): string; postData(): string }; fulfill(options: { contentType: string; body: string | Buffer }): Promise<unknown> }) => {
      if (route.request().method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: true }) });
      voiced.push(JSON.parse(route.request().postData()).text);
      return route.fulfill({ contentType: 'audio/wav', body: silentWav(0.05) });
    });
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' }); await f.open('chat-a');
    const reply = f.page.locator('.message.agent').first();
    await reply.locator('.message-body p').evaluate((element: Element) => { const range = document.createRange(); range.selectNodeContents(element); const selection = getSelection()!; selection.removeAllRanges(); selection.addRange(range); });
    await reply.getByRole('button', { name: 'Read aloud', exact: true }).click();
    await reply.getByRole('button', { name: 'Stop', exact: true }).waitFor(); await reply.getByRole('button', { name: 'Read aloud', exact: true }).waitFor({ timeout: 15000 });
    assert.equal(voiced.join(''), selected); assert.ok(voiced.every(piece => piece.isWellFormed() && piece.length <= 3800));
    if (selected.startsWith('hello')) { assert.ok(voiced.length > 1); const first = voiced[0]; assert.ok(first !== undefined && first.length <= 300); assert.ok(voiced.slice(0, -1).every(piece => /\s$/.test(piece))); }
  } finally { await f.close(); }
});

for (const activation of ['mouse', 'keyboard']) test(`Read aloud accepts a selected passage by ${activation} without dismissing Quote selection`, async () => {
  const f = await fixture({ chat: [['t1', 'Explain.', 'Alpha selected words omega.']] }), voiced: string[] = [];
  try {
    await f.page.route('**/api/read-aloud', async (route: { request(): { method(): string; postData(): string }; fulfill(options: { contentType: string; body: string | Buffer }): Promise<unknown> }) => {
      if (route.request().method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ available: true }) });
      voiced.push(JSON.parse(route.request().postData()).text);
      return route.fulfill({ contentType: 'audio/wav', body: silentWav() });
    });
    await f.page.reload(); await f.page.locator('.startup-splash').waitFor({ state: 'detached' }); await f.open('chat-a');
    const reply = f.page.locator('.message.agent').first(), paragraph = reply.locator('.message-body p');
    await paragraph.scrollIntoViewIfNeeded();
    const box = await paragraph.evaluate((element: Element) => { const range = document.createRange(); range.setStart(element.firstChild!, 6); range.setEnd(element.firstChild!, 20); const rect = range.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }; });
    await f.page.mouse.move(box.x + 1, box.y + box.height / 2); await f.page.mouse.down();
    await f.page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 }); await f.page.mouse.up();
    assert.equal(await f.page.evaluate(() => getSelection()!.toString()), 'selected words');
    await f.page.getByRole('button', { name: 'Quote selection' }).waitFor();
    const read = reply.getByRole('button', { name: 'Read aloud', exact: true });
    if (activation === 'mouse') await read.click({ timeout: 3000 });
    else {
      for (let count = 0; count < 20 && !(await read.evaluate((element: Element) => element === document.activeElement)); count++) await f.page.keyboard.press('Tab');
      assert.ok(await read.evaluate((element: Element) => element === document.activeElement), 'Read aloud is reachable by Tab');
      assert.equal(await f.page.evaluate(() => getSelection()!.toString()), 'selected words');
      await f.page.keyboard.press('Enter');
    }
    await reply.getByRole('button', { name: 'Stop', exact: true }).waitFor();
    assert.deepEqual(voiced, ['selected words']);
  } finally { await f.close(); }
});
