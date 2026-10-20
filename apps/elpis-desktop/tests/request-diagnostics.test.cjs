const { createTestTempDir, removeTestTempDir } = require('./temp-root.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

test('an actual bridge failure displays its code and request ID in the renderer in both themes', async () => {
  const cache = path.join(os.homedir(), '.cache', 'elpis-tests');
  await fs.mkdir(cache, { recursive: true });
  const home = createTestTempDir(path.join(cache, 'request-ui-'));
  const { startDesktopServer } = await import('../bridge/server.mjs');
  const client = Object.assign(new EventEmitter(), { close() {}, async settings() { throw new TypeError('PRIVATE_CONTENT'); } });
  const app = await startDesktopServer({ client, elpisHome: home, trashFile: path.join(home, 'trash.json') });
  try {
    const launch = new URL(app.url), origin = launch.origin;
    const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: launch.hash.slice(7) }) });
    const cookie = auth.headers.get('set-cookie').split(';')[0];
    for (const colorScheme of ['light', 'dark']) {
      const f = await fixture({ colorScheme, width: 1280, height: 800 });
      try {
        const requestIds = new Set();
        await f.page.route('**/api/settings', async route => {
          const reply = await fetch(origin + '/api/settings', { headers: { Cookie: cookie } });
          const body = await reply.json(); requestIds.add(body.requestId);
          await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(body) });
        });
        await openSettings(f.page);
        await f.page.getByRole('tab', { name: 'Configuration', exact: true }).click();
        const notice = f.page.locator('.settings-notice:visible').filter({ hasText: /Application request failed.*ELPIS_REQUEST_FAILED/ }).first();
        await notice.waitFor();
        const shownId = (await notice.innerText()).match(/request ([a-f0-9-]{36})/)?.[1];
        assert.ok(shownId && requestIds.has(shownId), 'the displayed ID belongs to a real bridge failure');
        assert.doesNotMatch(await notice.innerText(), /PRIVATE_CONTENT/);
        await f.page.screenshot({ path: `/tmp/elpis-request-diagnostics-${colorScheme}.png` });
        assert.deepEqual(f.errors, []);
      } finally { await f.close(); }
    }
  } finally { await app.close(); removeTestTempDir(home); }
});
