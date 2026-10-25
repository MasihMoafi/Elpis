const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { PORTRAIT_DATA_URL } = require('../bridge/matilda-face.cjs');

test('Love Spot conversations show their agent names and use the blood-red app icon', async () => {
  const threads = [
    { id: 'critic', name: 'Love Spot · Critic', agentNickname: 'Elpis' },
    { id: 'reviewer', name: 'Love Spot · Reviewer' },
    { id: 'ordinary', name: 'Project chat' },
    { id: 'matilda', name: 'Love Spot' },
    { id: 'nickname', name: 'Review cache', agentNickname: 'Cache reviewer' },
  ].map(thread => ({ ...thread, modelProvider: 'openai', model: 'gpt-6-luna', status: { type: 'idle' }, desktopAccess: { writable: false, reason: 'Fixture' } }));
  const clients = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    for await (const chunk of req) {}
    const json = data => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(data)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); clients.add(res); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [] });
    if (url.pathname === '/api/threads') return json({ data: threads, nextCursor: null });
    if (url.pathname.startsWith('/api/threads/')) {
      const thread = threads.find(item => url.pathname === `/api/threads/${item.id}`) || threads[0];
      return json({ thread, data: [{ turnId: 'turn', item: { id: `answer-${thread.id}`, type: 'agentMessage', text: 'What should I help you with?' } }], nextCursor: null });
    }
    try {
      const file = path.join(process.env.ELPIS_TEST_OUT || path.join(__dirname, '../out'), url.pathname === '/' ? 'index.html' : url.pathname);
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.webp') ? 'image/webp' : 'text/html');
      res.end(await fs.readFile(file));
    } catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(6000);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    for (const [id, speaker] of [['critic', 'Critic'], ['reviewer', 'Reviewer'], ['nickname', 'Cache reviewer']]) {
      await page.locator(`.thread-row[data-thread-id="${id}"] .thread-link`).click();
      await page.locator('.message.agent .speaker').filter({ hasText: speaker }).waitFor();
      assert.equal(await page.locator('.message.agent .speaker').textContent(), speaker);
      assert.match(await page.locator('.thread-meta').textContent(), new RegExp(speaker));
    }
    await page.locator('.thread-row[data-thread-id="matilda"] .thread-link').click();
    const portrait = page.locator('.message.agent img[alt="Matilda"]');
    await portrait.waitFor();
    assert.equal(await portrait.evaluate(image => image.complete && image.naturalWidth > 0), true);
    assert.match(await portrait.getAttribute('src'), /^data:image\/svg\+xml;base64,/,'the face is part of the page, never a request that can fail');
    const shape = await portrait.evaluate(async (image, source) => {
      const size = image.naturalWidth, r = size / 2, original = Object.assign(new Image(), { src: source });
      await original.decode();
      const pixels = picture => { const context = Object.assign(document.createElement('canvas'), { width: size, height: size }).getContext('2d'); context.drawImage(picture, 0, 0, size, size); return context.getImageData(0, 0, size, size).data; };
      const shown = pixels(image), wanted = pixels(original);
      const alpha = (k, turn) => shown[(Math.round(r - k * r * Math.sin(turn)) * size + Math.round(r + k * r * Math.cos(turn))) * 4 + 3];
      let opaque = 0, same = 0;
      for (let i = 0; i < shown.length; i += 4) {
        const x = i / 4 % size, y = Math.floor(i / 4 / size);
        if (wanted[i + 3] < 255 || (x - r) ** 2 + (y - r) ** 2 > (0.9 * r) ** 2) continue;
        opaque++; if (Math.abs(shown[i] - wanted[i]) + Math.abs(shown[i + 1] - wanted[i + 1]) + Math.abs(shown[i + 2] - wanted[i + 2]) < 24) same++;
      }
      return { portrait: same / opaque, rim: Array.from({ length: 16 }, (_, k) => alpha(0.95, k * Math.PI / 8)), beyond: [1, 3, 5, 7].map(k => alpha(1.05, k * Math.PI / 4)) };
    }, PORTRAIT_DATA_URL);
    assert.ok(shape.portrait > 0.9, `the disc shows her portrait, not an empty or broken face (${shape.portrait})`);
    assert.ok(shape.rim.every(a => a > 200) && shape.beyond.every(a => a === 0), `24 Oct, Masih: "this should be circular avatar profile looking": opaque just inside the circle at 16 angles, clear just outside it on the diagonals (${JSON.stringify(shape)})`);
    assert.equal(await page.locator('.message.agent .speaker').textContent(), 'Matilda');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); }, theme);
      await page.screenshot({ path: `/tmp/matilda-chat-shots/matilda-${theme}.png` });
    }
    await page.locator('.thread-row[data-thread-id="ordinary"] .thread-link').click();
    await page.locator('.message.agent').waitFor();
    assert.equal(await page.locator('.message.agent .speaker').count(), 0);
    assert.equal(await page.locator('.message.agent img[alt="Matilda"]').count(), 0);
    await page.locator('.thread-row[data-thread-id="critic"] .thread-link').click();
    const icon = page.locator('[data-nav-page="loveSpot"] svg');
    const output = process.env.ELPIS_IDENTITY_SCREENSHOTS || '/tmp/lovespot-identity';
    await fs.mkdir(output, { recursive: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; document.documentElement.classList.toggle('dark', theme === 'dark'); }, theme);
      const red = theme === 'dark' ? '#ec575e' : '#8b1017';
      assert.equal(await icon.evaluate(svg => getComputedStyle(svg).fill), theme === 'dark' ? 'rgb(236, 87, 94)' : 'rgb(139, 16, 23)');
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--love-red').trim().toLowerCase()), red);
      await page.screenshot({ path: path.join(output, `${theme}.png`) });
    }
    const shell = page.locator('.app-shell');
    await page.locator('[data-nav-page="loveSpot"]').click();
    await page.waitForFunction(() => document.querySelector('.app-shell')?.dataset.workspace === 'loveSpot');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      const red = theme === 'dark' ? '#ec575e' : '#8b1017';
      const palette = await page.locator('.love-spot-tools').evaluate(el => {
        const style = getComputedStyle(el);
        return ['--primary', '--primary-action', '--primary-foreground', '--primary-action-content'].map(token => style.getPropertyValue(token).trim().toLowerCase());
      });
      assert.deepEqual(palette, [red, red, theme === 'dark' ? '#0a0b0d' : '#fff', theme === 'dark' ? '#0a0b0d' : '#fff']);
      assert.notEqual(await shell.evaluate(el => getComputedStyle(el).getPropertyValue('--primary').trim().toLowerCase()), red);
    }
  } finally {
    await browser.close();
    for (const client of clients) client.end();
    await new Promise(resolve => server.close(resolve));
  }
});
