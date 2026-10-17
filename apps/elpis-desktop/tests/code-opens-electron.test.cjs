const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fixture, CWD } = require('./parity-fixture.cjs');

test('real Electron clicks and Enter open inside Files; default native openFile never reaches shell.openPath', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-open-electron-'));
  const outside = path.join(root, 'گزارش with spaces.py');
  await fs.writeFile(outside, 'first\nSECOND_LINE\nlast\n');
  const files = await import('../bridge/files.mjs');
  const f = await fixture({ desktop: false, chat: [['t1', 'Show files', `[outside](${encodeURI(outside)}#L2) and [missing](${root}/missing.py).`]], routes: {
    '/api/file': async (body, url) => { try { return await files.readFile(url.searchParams.get('cwd'), url.searchParams.get('path')); } catch (error) { return { __http: 404, error: error.message }; } },
    '/api/files/dir': () => ({ data: [] }),
  } });
  let electron;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.resolve(__dirname, 'code-open-electron.cjs')], env: { ...process.env, XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '', HOME: root, ELPIS_HOME: root, CODEX_HOME: root, CODE_OPEN_PROFILE: path.join(root, 'profile'), CODE_OPEN_URL: f.page.url() } });
    const page = await electron.firstWindow(); page.setDefaultTimeout(8000);
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await page.getByRole('button', { name: 'outside', exact: true }).focus(); await page.keyboard.press('Enter');
    const editor = page.getByRole('textbox', { name: `Contents of ${outside}`, exact: true }); await editor.waitFor();
    assert.equal(await editor.inputValue(), 'first\nSECOND_LINE\nlast\n');
    assert.equal(await page.locator('.fe-line.hit').innerText(), 'SECOND_LINE');
    assert.deepEqual(await electron.evaluate(() => global.fileOpens), []);
    await page.getByRole('button', { name: 'Close side panel' }).click();
    // Exercise the public production preload, including validation and the main-to-renderer notification.
    await page.evaluate(file => window.elpisDesktop.openFile(`${file}:3`), outside);
    await editor.waitFor();
    assert.equal(await page.locator('.fe-line.hit').innerText(), 'last');
    assert.deepEqual(await electron.evaluate(() => global.fileOpens), []);
    await page.getByRole('button', { name: 'More file actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Open in default app', exact: true }).click();
    assert.deepEqual(await electron.evaluate(() => global.fileOpens), [outside]);
    await page.getByRole('button', { name: 'missing', exact: true }).click();
    await page.getByRole('region', { name: 'File viewer' }).getByRole('alert').waitFor();
    assert.deepEqual(await electron.evaluate(() => global.fileOpens), [outside]);
  } finally { if (electron) await electron.close(); await f.close(); }
});
