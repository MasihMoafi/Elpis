const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { fixture, THREADS } = require('./parity-fixture.cjs');

const width = 640, height = 640, visibleRows = 560;
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type), size = Buffer.alloc(4), checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length); checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([size, name, data, checksum]);
}
function png(lastOpaqueRow) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * (1 + width * 4) + 1 + x * 4;
    raw[pixel] = 65; raw[pixel + 1] = 120; raw[pixel + 2] = 185;
    raw[pixel + 3] = x >= 8 && x < 56 && y >= 3 && y < lastOpaqueRow ? 255 : 0;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const transparentPng = png(visibleRows), opaquePng = png(height);
const pixels = bottom => bottom / height;
const near = value => Math.round(value * 10) / 10;

async function gapBelowVisibleImage(page, name, visibleRatio) {
  const image = page.locator(`.message.agent img[alt="${name}"]`);
  const button = page.getByRole('button', { name: `Reply to image: ${name}`, exact: true });
  if (!await image.count()) {
    const state = await page.evaluate(() => ({ messages: [...document.querySelectorAll('.message.agent')].map(message => message.innerText.slice(0, 90)), images: [...document.images].map(img => ({ alt: img.alt, src: (() => { try { const url = new URL(img.src); return `${url.protocol}//${url.host}${url.pathname}`; } catch { return img.src.slice(0, 24); } })(), complete: img.complete, width: img.naturalWidth, parent: img.parentElement?.className })) }));
    throw new Error(`missing ${name} image: ${JSON.stringify(state)}`);
  }
  await image.evaluate(img => img.decode()); await button.waitFor();
  const imageBox = await image.boundingBox(), buttonBox = await button.boundingBox();
  return { gap: near(buttonBox.y - (imageBox.y + imageBox.height * visibleRatio)), width: near(imageBox.width), image, button };
}
function assertReplyGap(result, label) {
  assert.ok(result.gap >= 4 && result.gap <= 8, `${label} has a ${result.gap}px gap from visible pixels to Reply (expected 4–8px)`);
}

for (const colorScheme of ['light', 'dark']) test(`transparent image Reply stays under visible pixels through resize without crowding Matilda (${colorScheme})`, async t => {
  const thread = { ...THREADS[0], name: 'Love Spot · Matilda' };
  const f = await fixture({
    staticDir: process.env.ELPIS_RENDERER_OUT,
    width: 1200, height: 900, colorScheme, readyThreadId: 'chat-b',
    threads: [thread, ...THREADS.slice(1)], chat: [['image-turn', 'Look at these.', 'Pictures shown.']],
    routes: {
      '/api/threads/chat-a': () => ({ thread, nextCursor: null, data: [
      { turnId: 'tail', item: { id: 'matilda-next', type: 'agentMessage', text: 'Matilda follows.' } },
      { turnId: 'image-turn', item: { id: 'pictures', type: 'agentMessage', text: 'Pictures shown.\n\n![Transparent](reply-images/transparent.png)\n\n![Opaque](reply-images/opaque.png)\n\n![Cross-origin](https://images.example/transparent.png)' } },
      { turnId: 'image-turn', item: { id: 'viewed', type: 'imageView', path: '/tmp/viewed.png' } },
      { turnId: 'image-turn', item: { id: 'prompt', type: 'userMessage', content: [{ type: 'text', text: 'Look at these.' }] } },
      ] }),
      '/api/file/asset': (_body, url) => ({ __asset: { mimeType: 'image/png', bytes: url.searchParams.get('path') === 'reply-images/transparent.png' ? transparentPng : opaquePng } }),
      '/api/threads/chat-a/turns/image-turn/items/viewed/media/0': () => ({ __asset: { mimeType: 'image/png', bytes: transparentPng } }),
    },
  });
  t.after(() => f.close());
  const { page } = f;
  const imageResponses = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname === '/api/file/asset') imageResponses.push([url.pathname, url.searchParams.get('path'), response.status()]);
    else if (url.hostname === 'images.example') imageResponses.push([url.hostname + url.pathname, response.status()]);
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/file/asset' || url.hostname === 'images.example') imageResponses.push([url.pathname, request.failure()?.errorText]);
  });
  await page.route('https://images.example/**', route => route.fulfill({ contentType: 'image/png', body: transparentPng }));
  await page.reload();
  await f.open('chat-a');

  let transparent;
  try { transparent = await gapBelowVisibleImage(page, 'Transparent', pixels(visibleRows)); }
  catch (error) { throw new Error(`${String(error)}; image responses=${JSON.stringify(imageResponses)}`); }
  const opaque = await gapBelowVisibleImage(page, 'Opaque', 1);
  const crossOrigin = await gapBelowVisibleImage(page, 'Cross-origin', pixels(visibleRows));
  assertReplyGap(transparent, 'same-origin transparent image');
  assertReplyGap(opaque, 'opaque image');
  assert.ok(crossOrigin.gap > 40, `unreadable cross-origin alpha keeps the complete image box as fallback (${crossOrigin.gap}px)`);
  assert.equal(await transparent.image.evaluate(img => img.parentElement?.dataset.trimmed), 'true');
  assert.equal(await opaque.image.evaluate(img => img.parentElement?.dataset.trimmed), undefined);
  assert.equal(await crossOrigin.image.evaluate(img => img.parentElement?.dataset.trimmed), undefined);

  const next = page.locator('.message.agent.matilda-message').filter({ hasText: 'Matilda follows.' }).last();
  const portrait = next.locator('span.relative img:visible').first();
  await portrait.waitFor();
  const buttonBox = await transparent.button.boundingBox(), portraitBox = await portrait.boundingBox();
  assert.ok(buttonBox.y + buttonBox.height <= portraitBox.y, 'the Reply button does not overlap the following Matilda portrait');

  await page.locator('.worked-for > summary').click();
  const thumb = page.locator('.activity-thumb').last(), thumbReply = page.getByRole('button', { name: 'Reply to image: viewed.png', exact: true });
  await thumb.waitFor(); await thumbReply.waitFor();
  const thumbBox = await thumb.boundingBox(), thumbButtonBox = await thumbReply.boundingBox();
  assert.equal(near(thumbBox.height), 28, 'small viewed-image thumbnails keep their original size');
  assert.equal(await thumb.evaluate(img => img.parentElement?.dataset.trimmed), undefined, 'small viewed-image thumbnails are not cropped');
  assert.equal(near(thumbButtonBox.y - (thumbBox.y + thumbBox.height)), 4, 'the small thumbnail keeps its existing gap');

  await page.setViewportSize({ width: 820, height: 900 });
  await page.waitForFunction(() => document.querySelector('.message.agent .markdown img[alt="Transparent"]')?.getBoundingClientRect().width < 600);
  const narrowTransparent = await gapBelowVisibleImage(page, 'Transparent', pixels(visibleRows));
  const narrowOpaque = await gapBelowVisibleImage(page, 'Opaque', 1);
  assert.ok(narrowTransparent.width < transparent.width - 20, 'the image responds to the narrower transcript');
  assertReplyGap(narrowTransparent, 'resized transparent image');
  assertReplyGap(narrowOpaque, 'resized opaque image');
  const resizedButton = await narrowTransparent.button.boundingBox(), resizedPortrait = await portrait.boundingBox();
  assert.ok(resizedButton.y + resizedButton.height <= resizedPortrait.y, 'the resized Reply button does not overlap Matilda');
  assert.deepEqual(f.errors, []);
});
