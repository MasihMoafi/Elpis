const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');
const projectChat = cwd => ({ id: 'chat-a', name: 'Project preview', cwd, model: 'sol', modelProvider: 'openai', desktopAccess: { writable: true, mode: 'direct' }, status: { type: 'idle' } });
const projectRoutes = cwd => ({ '/api/threads/chat-a/resume': () => ({ thread: projectChat(cwd) }) });

for (const scheme of ['light']) test(`real Electron opens the started project in the native browser and stops it with a click (${scheme})`, async () => {
  const root = await fs.mkdtemp('/tmp/elpis-preview-native-');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.cjs' } }));
  const html = `<!doctype html><title>Project preview proof</title><style>body{font:16px system-ui;padding:24px;color:#222;background:#fafafa}button{font:inherit;padding:8px 12px}</style><h1>Project preview proof</h1><button onclick="this.textContent='Clicked in preview'">Test this page</button>`;
  await fs.writeFile(path.join(root, 'server.cjs'), `require('node:http').createServer((q,s)=>{s.setHeader('Content-Type','text/html');s.end(${JSON.stringify(html)})}).listen(process.env.PORT,'127.0.0.1',()=>console.log('native preview ready'))`);
  const manager = (await import('../bridge/dev-servers.mjs')).createDevServers();
  const f = await fixture({ desktop: false, routes: {
    ...projectRoutes(root),
    '/api/dev-servers': () => manager.status(root), '/api/dev-servers/detect': () => manager.detect(root),
    '/api/dev-servers/start': body => manager.start(root, body.name), '/api/dev-servers/stop': body => manager.stop(root, body.name),
  } });
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  let electron;
  try {
    const display = await new Promise((resolve, reject) => { xvfb.once('error', reject); xvfb.once('exit', code => reject(Error(`Xvfb exited ${code}`))); xvfb.stdio[3].once('data', chunk => resolve(`:${String(chunk).trim()}`)); });
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', '--force-device-scale-factor=1', path.resolve(__dirname, 'dev-server-electron.cjs')], env: { ...process.env, DISPLAY: display, HOME: root, ELPIS_HOME: root, CODEX_HOME: root, XDG_CONFIG_HOME: root, PREVIEW_TEST_PROFILE: path.join(root, 'profile'), PREVIEW_TEST_URL: f.page.url() } });
    const page = await electron.firstWindow(); page.setDefaultTimeout(10000);
    await page.emulateMedia({ colorScheme: scheme });
    const resumed = page.waitForResponse(response => response.url().endsWith('/api/threads/chat-a/resume'));
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click(); await resumed;
    await page.evaluate(() => window.elpisDesktop.browser.command('new'));
    await page.getByRole('button', { name: 'Detect dev server', exact: true }).click();
    await page.getByRole('button', { name: 'Start preview: dev' }).focus(); await page.keyboard.press('Enter');
    await page.getByText(/127\.0\.0\.1 · Server running/).waitFor();
    const { servers: [server] } = await manager.status(root);
    const web = electron.context().pages().find(tab => tab !== page);
    assert.ok(web); await web.getByRole('heading', { name: 'Project preview proof' }).waitFor();
    await web.getByRole('button', { name: 'Test this page' }).click();
    await web.getByRole('button', { name: 'Clicked in preview' }).waitFor();
    await page.getByRole('button', { name: 'View logs', exact: true }).click();
    await page.getByRole('log').getByText(/native preview ready/).waitFor();
    await assertUiFit(page.getByRole('region', { name: 'Dev server preview' }), 'native controls fit');
    await web.getByRole('button', { name: 'Clicked in preview' }).click();
    await web.waitForFunction(() => innerWidth > 300 && innerHeight > 200);
    await web.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    if (process.env.ELPIS_PARITY_SHOTS) {
      await web.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `dev-page-${scheme}.png`) });
      // Wait for the native page's completed frame before capturing Xvfb after a resize.
      await electron.evaluate(({ BrowserWindow }) => { const host = BrowserWindow.getAllWindows()[0]; host.webContents.invalidate(); for (const view of host.contentView.children) view.webContents?.invalidate(); });
      await new Promise(resolve => setTimeout(resolve, 250));
      const bounds = await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentBounds());
      await run('python3', ['-c', 'from PIL import ImageGrab;import json,sys;b=json.loads(sys.argv[3]);ImageGrab.grab(xdisplay=sys.argv[1]).crop((b["x"],b["y"],b["x"]+b["width"],b["y"]+b["height"])).save(sys.argv[2])', display, path.join(process.env.ELPIS_PARITY_SHOTS, `dev-native-${scheme}.png`), JSON.stringify(bounds)]);
    }
    await page.getByRole('button', { name: 'Hide logs', exact: true }).click();
    await page.getByRole('button', { name: 'Stop server', exact: true }).click();
    await page.getByText(/Server stopped/).waitFor();
    await assert.rejects(fetch(server.url));
  } finally { await electron?.close(); xvfb.kill(); await manager.close(); await f.close(); }
});
