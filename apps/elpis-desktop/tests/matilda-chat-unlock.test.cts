// 6 Nov, Masih (under a red "Matilda is off. Turn her on to talk to her." bar): "when I directly go to her and message, it
// should automatically unlock her." Writing in her chat turns her on; off still keeps her quiet on the board until then.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');

test('a message in Matilda\'s chat turns her on instead of being refused', async () => {
  const chatId = (n: number) => `00000000-0000-4000-8000-${String(n + 301).padStart(12, '0')}`, love = chatId(0);
  const f = await loveSpotFixture({ threadId: chatId });
  try {
    const { page } = f;
    // Her chat comes from a note she answers on the board.
    await f.open(page);
    const bounds = await page.locator('.excalidraw').boundingBox();
    await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.press('t');
    await page.mouse.click(bounds.x + 450, bounds.y + 300); await page.keyboard.type('Hello Matilda.'); await page.keyboard.press('Escape');
    await f.waitFor((scene: { elements: { id: string; isDeleted?: boolean }[] }) => scene.elements.some(element => element.id === 'love-reply-turn-1' && !element.isDeleted), 'Matilda did not reply', 20000);
    // He turns her off on the board.
    const toggle = page.getByRole('switch', { name: 'Matilda', exact: true });
    await toggle.click(); await page.waitForFunction(() => document.querySelector('[role="switch"][aria-label="Matilda"]')?.getAttribute('aria-checked') === 'false');
    const before = f.turns.length;
    // Then writes to her directly in her chat.
    await page.locator(`aside [data-thread-id="${love}"] .thread-link`).click();
    const box = page.getByRole('textbox', { name: 'Message Elpis' });
    await box.fill('What should I start the day with?'); await box.press('Enter');
    await f.waitFor(() => f.turns.length === before + 1, 'the message to her was not sent', 15000);
    assert.equal(f.turns.at(-1).text, 'What should I start the day with?');
    assert.equal(await page.getByText(/Matilda is off/).count(), 0, 'no refusal');
    // She is on again, on the board too.
    await f.open(page);
    assert.equal(await page.getByRole('switch', { name: 'Matilda', exact: true }).getAttribute('aria-checked'), 'true');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
