import type { Page } from 'playwright-core';

const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { fixture }: typeof import('./parity-fixture.cts') = require('./parity-fixture.cts');

const cases = [
  ['reading', 1100, false],
  ['latest message', 1100, true],
  ['narrow window', 800, false],
] as const;

for (const [name, width, atBottom] of cases) test(`working status keeps the layout steady: ${name}`, async () => {
  const chat: [string, string, string][] = Array.from(
    { length: 20 },
    (_, i) => [`t${i}`, `Prompt ${i}`, `Reply ${i}: ${'text '.repeat(80)}`],
  );
  const f = await fixture({ chat, width, height: 750 });
  try {
    await f.open('chat-a');
    const page = f.page as unknown as Page;
    await page.locator('.chat-scroll').evaluate((element: HTMLElement, bottom: boolean) => {
      element.scrollTop = bottom ? element.scrollHeight : element.scrollHeight / 2;
    }, atBottom);
    await page.waitForTimeout(300);
    const geometry = () => page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('.chat-scroll')!;
      const composer = document.querySelector<HTMLElement>('.composer')!;
      return {
        height: scroll.clientHeight,
        top: scroll.scrollTop,
        gap: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight,
        composer: composer.getBoundingClientRect().top,
      };
    });
    const before = await geometry();
    f.emit('message', { method: 'turn/started', params: { threadId: 'chat-a', turn: { id: 't19' } } });
    await page.locator('.composer-working .turn-working').waitFor();
    await page.waitForTimeout(300);
    const started = await geometry();
    assert.equal(started.height, before.height, 'starting work does not resize the transcript');
    assert.equal(started.composer, before.composer, 'starting work does not move the composer');
    if (!atBottom) assert.equal(started.top, before.top, 'starting work preserves the reading place');
    else assert.ok(started.gap <= 2, 'starting work keeps the newest message in view');
    f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 't19', status: 'completed' } } });
    await page.locator('.composer-working .turn-working').waitFor({ state: 'detached' });
    await page.waitForTimeout(300);
    const ended = await geometry();
    assert.equal(ended.height, before.height, 'ending work does not resize the transcript');
    assert.equal(ended.composer, before.composer, 'ending work does not move the composer');
    if (!atBottom) assert.equal(ended.top, before.top, 'ending work preserves the reading place');
    else assert.ok(ended.gap <= 2, 'ending work keeps the newest message in view');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
