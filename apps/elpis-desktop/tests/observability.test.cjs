const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');

test('Observability opens an empty page and makes no observability requests, including after returning', async () => {
  const requests = [];
  const f = await fixture({ width: 1280, height: 900, routes: {
    '/api/observability': () => ({ available: true, totals: { attempts: 1, saved: 42 }, chats: { data: [{ id: 'chat-a', chat: { name: 'Planted observability record' }, totals: { attempts: 1, saved: 42 } }], nextCursor: null } }),
  } });
  try {
    const { page } = f;
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/observability')) requests.push(request.url()); });
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await chooseTheme(page, theme);
      const entry = page.locator('.nav-list').getByRole('button', { name: 'Observability', exact: true });
      assert.equal(await entry.locator('svg').count(), 1);
      await entry.focus(); await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
      const body = page.locator('.workspace-content > .page-scroll:not([hidden])');
      assert.deepEqual({ requests, children: await body.locator(':scope > *').count(), text: await body.innerText() }, { requests: [], children: 0, text: '' });
      if (process.env.ELPIS_SHOTS) {
        await page.mouse.click(700, 200);
        await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, `observability-${theme}.png`), animations: 'disabled' });
      }
      await page.getByRole('button', { name: 'New chat', exact: true }).click();
      await entry.click();
      assert.equal(await body.innerText(), '');
      f.emit('message', { method: 'thread/deleted', params: { threadId: 'chat-a' } });
      await page.waitForTimeout(250);
      assert.deepEqual(requests, []);
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
