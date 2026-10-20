const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

test('Love Spot conversations show their agent names and use the blood-red app icon', async () => {
  const threads = [
    { id: 'critic', name: 'Love Spot · Critic', agentNickname: 'Elpis' },
    { id: 'reviewer', name: 'Love Spot · Reviewer' },
    { id: 'ordinary', name: 'Project chat' },
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
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
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
    await page.locator('.thread-row[data-thread-id="ordinary"] .thread-link').click();
    await page.locator('.message.agent').waitFor();
    assert.equal(await page.locator('.message.agent .speaker').count(), 0);
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
