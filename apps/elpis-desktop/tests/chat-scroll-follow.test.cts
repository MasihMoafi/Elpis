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
