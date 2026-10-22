// node tests/polish.runtime.cjs PACKAGED_APP [9486]
// Real Electron, real bridge, empty isolated home, no route mocking or renderer patches.
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme, openSettings, leaveSettings } = require('./controls.cjs');
const { PAGES, SECTIONS, visit } = require('./settings-row-audit.cjs');
const { scanDisclosures, modelSpacing, cornerWidths, checkWidths, shot } = require('./polish-check.cjs');

async function main() {
  assert.ok(process.argv[2], 'Pass a packaged app directory');
  const app = path.resolve(process.argv[2]), port = Number(process.argv[3] || 9486);
  assert.ok(port >= 9420 && port <= 9499, 'Use an isolated CDP port');
  const url = `http://127.0.0.1:${port}`;
  assert.ok(!await fetch(`${url}/json/version`).then(() => true, () => false), 'CDP port must be free');
  const evidence = process.env.ELPIS_POLISH_EVIDENCE || '/home/masih/.cache/elpis-tests/polish/real';
  await fs.mkdir(evidence, { recursive: true });
  const problems = [], measurements = [];
  const home = await fs.mkdtemp('/tmp/e2e-polish-');
  await fs.mkdir(`${home}/run`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, ELPIS_HOME: `${home}/elpis`, CODEX_HOME: `${home}/codex`, ELPIS_CONFIG_DIR: `${home}/elpis`,
    ELPIS_DESKTOP_PROFILE: `${home}/desktop`, XDG_CONFIG_HOME: `${home}/.config`, XDG_CACHE_HOME: `${home}/.cache`,
    XDG_DATA_HOME: `${home}/.local/share`, XDG_STATE_HOME: `${home}/.local/state`, XDG_RUNTIME_DIR: `${home}/run`,
    TMPDIR: home, EXCALIDRAW_LOCAL_DIR: `${home}/love-spot`, EXCALIDRAW_SCREENSHOTS_DIR: `${home}/Screenshots` };
  for (const key of ['WAYLAND_DISPLAY', 'XDG_SESSION_TYPE', 'ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELECTRON_RUN_AS_NODE']) delete env[key];
  const log = await fs.open(path.join(evidence, 'app.log'), 'a');
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1200x24', `${app}/launch`, '--ozone-platform=x11',
    ...(process.env.ELPIS_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []), `--remote-debugging-port=${port}`],
    { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
  child.on('error', error => problems.push(error.message));
  await log.close();
  let browser;
  try {
    const until = Date.now() + 30000;
    while (Date.now() < until && child.exitCode === null) {
      if (await fetch(`${url}/json/list`).then(r => r.json()).then(items => items.some(item => item.type === 'page'), () => false)) {
        browser = await chromium.connectOverCDP(url); break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(browser, `App did not open: ${await fs.readFile(path.join(evidence, 'app.log'), 'utf8')}`);
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'Real bridge page is open'); page.setDefaultTimeout(10000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 4, mobile: false });
    for (const theme of ['light', 'dark']) {
      await chooseTheme(page, theme);
      for (const state of ['idle', 'focused']) {
        if (state === 'focused') await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).focus();
        for (const selector of ['.composer-tray', '.composer']) {
          const card = page.locator(selector).filter({ visible: true });
          if (!await card.count()) continue;
          const measured = await cornerWidths(card); measurements.push({ theme, state, selector, ...measured });
          try { checkWidths(measured, `${theme} ${state} ${selector}`); } catch (error) { problems.push(error.message); }
          await shot(card, path.join(evidence, 'shots'), `${theme}-${state}-${selector.slice(1)}`);
        }
      }
      await openSettings(page);
      for (const [section, names] of [[false, PAGES], [true, SECTIONS]]) for (const name of names) {
        await visit(page, name, section);
        problems.push(...(await scanDisclosures(page)).map(hit => `${theme} ${name}: ${hit}`));
        if (['Models & accounts', 'Configuration', 'Personalization'].includes(name) && !section) {
          const closed = page.locator('details:not([open]) > summary').filter({ hasText: 'Advanced: custom model', visible: true });
          while (await closed.count()) await closed.first().click();
          for (const m of await page.evaluate(modelSpacing)) {
            measurements.push({ theme, page: name, ...m });
            for (const key of ['selectToLabel', 'labelToHint', 'hintToField']) if (m[key] !== null && m[key] + .5 < m.rowGap) problems.push(`${theme} ${m.label}: ${key} ${m[key]}px < ${m.rowGap}px`);
          }
          await shot(page.locator('.settings-page'), path.join(evidence, 'shots'), `${theme}-${name.replace(/\W+/g, '-').toLowerCase()}`);
        }
      }
      await leaveSettings(page);
      for (const name of ['Lab', 'Workflows', 'Love Spot', 'Customize']) {
        await page.getByRole('button', { name, exact: true }).first().click();
        await page.waitForTimeout(200);
        problems.push(...(await scanDisclosures(page)).map(hit => `${theme} ${name}: ${hit}`));
      }
      await page.getByRole('button', { name: 'New chat', exact: true }).first().click();
    }
    await page.reload();
    problems.push(...(await scanDisclosures(page)).map(hit => `after reload: ${hit}`));
    await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ home, measurements, problems,
      unrun: ['Real running turn: empty profile has no provider credentials', 'Populated history, provider rejection and process restart: separate acceptance scenarios'] }, null, 2));
    console.log(JSON.stringify({ home, checks: measurements.length, problems }, null, 2));
    assert.deepEqual(problems, []);
  } finally {
    await browser?.close().catch(() => {});
    if (child.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    execFileSync(process.env.ELPIS_E2E_HELPER || '/home/masih/.cache/elpis-tests/e2e/app.sh', ['stop', home]);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
