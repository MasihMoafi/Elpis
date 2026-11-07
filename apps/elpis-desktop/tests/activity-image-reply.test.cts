const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, CWD } = require('./parity-fixture.cts');

for (const colorScheme of ['light', 'dark']) test(`viewed images keep replies out of the activity summary (${colorScheme})`, async () => {
  const images = [1, 2, 3].map(n => ({ id: `view-${n}`, type: 'imageView', path: `${CWD}/image-${n}.png` }));
  const f = await fixture({ colorScheme, chat: [['t1', 'Review the images', 'Images reviewed.', images]] });
  try {
    const { page } = f;
    await f.open('chat-a');
    await page.locator('.worked-for > summary').click();
    const summary = page.locator('.activity-group > summary');
    await summary.getByText('Viewed 3 images').waitFor();
    assert.equal(await summary.locator('img.activity-thumb').count(), 3);
    const reply = summary.getByRole('button', { name: 'Reply to image: image-1.png' });
    assert.equal(await summary.getByRole('button', { name: /^Reply to image:/ }).count(), 3);
    assert.equal(await reply.evaluate((button: Element) => getComputedStyle(button).opacity), '0', 'thumbnail reply is hidden until hover or focus');
    assert.ok(await summary.evaluate((row: Element) => row.getBoundingClientRect().height <= 40), 'thumbnails do not add a reply-label row');
    await summary.locator('img.activity-thumb').first().click();
    const dialog = page.getByRole('dialog', { name: 'image-1.png' });
    await dialog.waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await reply.focus();
    await page.waitForFunction(() => document.activeElement !== null && getComputedStyle(document.activeElement).opacity === '1');
    await reply.click();
    const preview = page.locator('.composer [data-slot="reply-preview"]');
    await preview.getByRole('img', { name: 'image-1.png' }).waitFor();
    await preview.getByRole('button', { name: 'Cancel reply' }).click();
    await summary.click();
    await page.locator('.activity-group-body').getByRole('button', { name: 'Reply to image: image-1.png' }).click();
    await page.locator('.composer [data-slot="reply-preview"]').getByRole('img', { name: 'image-1.png' }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
