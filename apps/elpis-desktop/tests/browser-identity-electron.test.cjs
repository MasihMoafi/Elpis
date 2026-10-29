// Google sign-in in the side panel browser (Masih, 29 Oct: "The browser you're using doesn't support JavaScript").
// A local page records what a browser tab sends and exposes, opened through the address bar of the real app window:
// it must look like stock Chrome of its own Chromium version, with no Electron or app token, in the page, in an
// embedded cross-site frame and in a window.open popup. The app's own window keeps its default identity.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fixture } = require('./parity-fixture.cjs');

const REPORT = `<script>(async () => {
  const data = navigator.userAgentData;
  const high = data ? await data.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness', 'model', 'uaFullVersion']) : null;
  await fetch('/report' + location.pathname, { method: 'POST', body: JSON.stringify({ userAgent: navigator.userAgent, brands: data ? data.brands : null,
    mobile: data ? data.mobile : null, platform: data ? data.platform : null, fullVersionList: high && high.fullVersionList, webdriver: navigator.webdriver,
    languages: navigator.languages }) });
  document.title = 'Reported ' + location.pathname;
})()</script>`;

test('a browser tab presents stock Chrome to sign-in pages; the app window keeps its own identity', async () => {
  const profiles = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(profiles, { recursive: true });
  const root = await fs.mkdtemp(path.join(profiles, 'browser-identity-'));
  const f = await fixture({ desktop: false });
  const seen = new Map(), waiting = new Map();
  const report = name => seen.get(name)?.page ? seen.get(name) : new Promise(resolve => waiting.set(name, resolve));
  const site = http.createServer((req, res) => {
    const name = req.url.replace(/^\/report/, '');
    if (req.url.startsWith('/report')) {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { const entry = { ...seen.get(name), page: JSON.parse(body) }; seen.set(name, entry); waiting.get(name)?.(entry); res.end(); });
      return;
    }
    seen.set(req.url, { headers: req.headers });
    res.setHeader('content-type', 'text/html');
    const port = site.address().port;
    // Google's sign-in asks for these high-entropy hints; Chrome then sends them to the same origin.
    if (req.url === '/sign-in') res.setHeader('accept-ch', 'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch');
    if (req.url === '/sign-in') res.end(`<title>Sign in</title><noscript>JavaScript is off</noscript>${REPORT}
      <iframe src="http://localhost:${port}/frame"></iframe><button onclick="window.open('/popup', '_blank')">Open popup</button>`);
    else res.end(REPORT);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const xvfb = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x960x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  const display = await new Promise((resolve, reject) => { xvfb.once('error', reject); xvfb.stdio[3].once('data', value => resolve(`:${String(value).trim()}`)); });
  let electron, nativeErrors = '';
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: ['--no-sandbox', '--ozone-platform=x11', path.resolve(__dirname, 'session-windows-electron.cjs')],
      env: { ...process.env, DISPLAY: display, WAYLAND_DISPLAY: '', ELECTRON_OZONE_PLATFORM_HINT: 'x11', HOME: root, ELPIS_HOME: root, SESSION_WINDOW_PROFILE: path.join(root, 'profile'), SESSION_WINDOW_URL: f.page.url() } });
    electron.process().stderr.on('data', data => { nativeErrors = (nativeErrors + data).slice(-6000); });
    const page = await electron.firstWindow(); page.setDefaultTimeout(15000);
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const chrome = await electron.evaluate(() => process.versions.chrome), major = chrome.split('.')[0];

    // Masih's path: a new browser tab in the side panel, an address typed and Enter.
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click(); await page.locator('.thread-row.active[data-thread-id="chat-a"]').waitFor();
    const show = page.getByRole('button', { name: 'Show side panel', exact: true }); if (await show.count()) await show.click();
    await page.getByRole('button', { name: 'New side panel tab', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Browser tab', exact: true }).click();
    const address = page.getByRole('textbox', { name: 'Search or enter a URL', exact: true });
    await address.fill(`${base}/sign-in`); await address.press('Enter');
    const signIn = await report('/sign-in');

    const userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    const brandSet = list => (list ?? []).map(item => item.brand).filter(brand => !/^Not.A.Brand$/.test(brand)).sort();
    const present = (entry, where) => {
      assert.ok(entry.page, `${where}: JavaScript ran and reported`);
      assert.equal(entry.headers['user-agent'], userAgent, `${where}: the request names stock Chrome ${major}, not Electron or the app`);
      assert.equal(entry.page.userAgent, userAgent, `${where}: navigator.userAgent matches the request`);
      assert.deepEqual(brandSet(entry.page.brands), ['Chromium', 'Google Chrome'], `${where}: client-hint brands are Chrome's`);
      assert.ok(entry.page.brands.every(item => item.version === major || /^Not.A.Brand$/.test(item.brand)), `${where}: brand versions are the major version`);
      assert.equal(entry.page.brands.length, 3, `${where}: one GREASE brand beside Chromium and Google Chrome`);
      const header = entry.page.brands.map(item => `"${item.brand}";v="${item.version}"`).join(', ');
      assert.equal(entry.headers['sec-ch-ua'], header, `${where}: the Sec-CH-UA header lists the same brands as the page`);
      assert.equal(entry.headers['sec-ch-ua-mobile'], '?0'); assert.equal(entry.headers['sec-ch-ua-platform'], '"Linux"');
      assert.ok(entry.page.fullVersionList.some(item => item.brand === 'Google Chrome' && item.version === chrome), `${where}: the full version list names Google Chrome ${chrome}`);
      assert.equal(entry.page.webdriver, false, `${where}: navigator.webdriver is false`);
      assert.doesNotMatch(JSON.stringify(entry), /Electron|elpis/i, `${where}: no Electron or app token anywhere`);
    };
    present(signIn, 'sign-in page');
    present(await report('/frame'), 'cross-site frame');

    // A sign-in popup opens as a browser tab with the same identity.
    await electron.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(wc => wc.getURL() === url).executeJavaScript("document.querySelector('button').click()", true), `${base}/sign-in`);
    const popup = await report('/popup'); present(popup, 'popup');
    assert.equal(popup.headers['sec-ch-ua-full-version-list'], popup.page.fullVersionList.map(item => `"${item.brand}";v="${item.version}"`).join(', '), 'the origin that asked gets the full version list');
    assert.equal(popup.headers['sec-ch-ua-arch'], '"x86"'); assert.equal(popup.headers['sec-ch-ua-platform-version'], '""');
    assert.equal(signIn.headers['sec-ch-ua-arch'], undefined, 'high-entropy hints wait for Accept-CH, as in Chrome');
    await page.getByRole('tab', { name: 'Reported /popup', exact: true }).waitFor();

    // Negative: the app's own window is untouched by the browser's identity.
    assert.match(await page.evaluate(() => navigator.userAgent), /Electron\//, 'the app window keeps Electron\'s user agent');
  } catch (error) { console.error(nativeErrors); throw error; } finally {
    if (electron) await electron.close(); xvfb.kill(); await f.close(); await new Promise(resolve => site.close(resolve));
  }
});
