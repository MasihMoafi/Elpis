// specs/chat-scrolling.md C1, C2, C4 (Masih, 10 Nov: "do the same for the scrolling of chats"): at the bottom a streaming
// reply stays in view; scrolled up even 40px nothing moves; "Scroll to bottom" shows once away and re-pins on click.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cts');

type Locator = {
  waitFor(options?: object): Promise<void>;
  click(): Promise<void>;
  count(): Promise<number>;
  evaluate(fn: (element: HTMLElement) => void): Promise<void>;
};
type Page = {
  locator(selector: string): Locator;
  getByText(text: string | RegExp, options?: object): Locator;
  getByRole(role: string, options?: object): Locator;
  evaluate<T>(fn: () => T): Promise<Awaited<T>>;
  waitForTimeout(ms: number): Promise<void>;
};
const view = (page: Page) => page.evaluate(() => {
  const s = document.querySelector('.chat-scroll') as HTMLElement;
  return { top: s.scrollTop, gap: s.scrollHeight - s.scrollTop - s.clientHeight, height: s.clientHeight };
});

test('a streaming reply follows only a reader at the bottom', async () => {
  const f = await fixture({ width: 1100, height: 750 });
  try {
    await f.open('chat-a');
    const page: Page = f.page;
    const line = (n: number) => `Paragraph ${n}: ${'words that fill the reply line '.repeat(6)}\n\n`;
    let sent = 0;
    const stream = (count: number) => { for (let i = 0; i < count; i++) f.emit('message', { method: 'item/agentMessage/delta', params: { threadId: 'chat-a', turnId: 'follow', itemId: 'follow-reply', delta: line(++sent) } }); };
    f.emit('message', { method: 'turn/started', params: { threadId: 'chat-a', turn: { id: 'follow' } } });
    f.emit('message', { method: 'item/started', params: { threadId: 'chat-a', turnId: 'follow', item: { id: 'follow-reply', type: 'agentMessage', text: '', status: 'inProgress' } } });
    stream(30);
    await page.getByText(/Paragraph 30:/).waitFor();
    const bottom = page.getByRole('button', { name: 'Scroll to bottom', exact: true });
    if (await bottom.count()) await bottom.click();
    await page.waitForTimeout(600);
    stream(10);
    await page.getByText(/Paragraph 40:/).waitFor();
    await page.waitForTimeout(300);
    assert.ok((await view(page)).gap <= 2, `C1: at the bottom the newest line stays in view (${JSON.stringify(await view(page))})`);
    // C2: forty pixels up, more text arrives and nothing moves.
    await page.locator('.chat-scroll').evaluate((s: HTMLElement) => { s.scrollTop -= 40; });
    await page.waitForTimeout(300);
    const held = (await view(page)).top;
    stream(10);
    await page.getByText(/Paragraph 50:/).waitFor();
    await page.waitForTimeout(300);
    assert.ok(Math.abs((await view(page)).top - held) <= 1, `C2: the reader's place holds (${held} → ${(await view(page)).top})`);
    // C4: far enough away the button shows; clicking it returns to the bottom and following resumes.
    await page.locator('.chat-scroll').evaluate((s: HTMLElement) => { s.scrollTop -= s.clientHeight; });
    await bottom.waitFor();
    await bottom.click();
    await page.waitForTimeout(800);
    stream(5);
    await page.getByText(/Paragraph 55:/).waitFor();
    await page.waitForTimeout(300);
    assert.ok((await view(page)).gap <= 2, `C4: after Scroll to bottom it follows again (${JSON.stringify(await view(page))})`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('switching chats keeps the reading place; sending pins to the bottom; the gutter is reserved', async () => {
  const chat = Array.from({ length: 30 }, (_, i) => [`s${i}`, `Scroll prompt ${i}`, `Scroll reply ${i}: ${'text that fills a line '.repeat(12)}`]);
  const f = await fixture({ width: 1100, height: 750, chat });
  try {
    await f.open('chat-a');
    const page: Page = f.page;
    await page.getByText(/Scroll reply 29:/).waitFor();
    await page.waitForTimeout(400);
    // C7: the scrollbar's gutter is always reserved, so text never shifts when it appears.
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.chat-scroll') as HTMLElement).scrollbarGutter), 'stable');
    // C5: scrolled up, away and back, the same place.
    await page.locator('.chat-scroll').evaluate((s: HTMLElement) => { s.scrollTop = Math.max(0, s.scrollTop - 300); });
    await page.waitForTimeout(300);
    // The place is the turn at the top of the view and its offset: pixel totals differ while unseen turns use estimates.
    const firstShown = () => page.evaluate(() => {
      const s = document.querySelector('.chat-scroll') as HTMLElement, top = s.getBoundingClientRect().top;
      const turn = [...s.querySelectorAll('.turn')].find(t => t.getBoundingClientRect().bottom > top) as HTMLElement;
      return { text: (turn.textContent ?? '').replace(/\d{1,2}:\d{2}\s?[AP]M/g, '').slice(0, 40), offset: Math.round(turn.getBoundingClientRect().top - top) };
    });
    const place = await firstShown();
    await f.open('chat-b');
    await page.waitForTimeout(400);
    await f.open('chat-a');
    await page.getByText(/Scroll reply 29:/).waitFor();
    await page.waitForTimeout(500);
    const back = await firstShown();
    assert.ok(back.text === place.text && Math.abs(back.offset - place.offset) <= 1, `C5: back at the same place (${JSON.stringify(place)} -> ${JSON.stringify(back)})`);
    // C8: sending from anywhere shows the new message at the bottom.
    await f.composer.fill('Pinned after sending');
    await f.composer.press('Enter');
    await page.getByText('Pinned after sending', { exact: true }).waitFor();
    await page.waitForTimeout(600);
    assert.ok((await view(page)).gap <= 2, `C8: a sent message pins to the bottom (${JSON.stringify(await view(page))})`);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
