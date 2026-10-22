// Packaged Electron + production bridge + real engine, all in a throwaway home.
// node tests/ledger-app.runtime.cjs APP ENGINE [9486] [--baseline]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseTheme } = require('./controls.cjs');

async function main() {
  const app = path.resolve(process.argv[2]), binary = path.resolve(process.argv[3]), port = Number(process.argv[4] || 9486), baseline = process.argv.includes('--baseline');
  assert(port >= 9420 && port <= 9499);
  assert(!await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false), 'DevTools port already in use');
  const shots = process.env.ELPIS_SHOTS || path.join(os.homedir(), '.cache/elpis-tests/ledger/shots');
  await fs.mkdir(shots, { recursive: true });
  const root = await fs.mkdtemp('/tmp/ledger-app-'), home = path.join(root, 'elpis');
  await fs.mkdir(home); await fs.mkdir(path.join(root, 'run'), { mode: 0o700 });
  await fs.writeFile(path.join(home, 'config.toml'), '[features]\nplugins = true\n[mcp_servers.ledger]\ncommand = "node"\nargs = ["--version"]\nenabled = true\n');
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', ELPIS_NODE_BIN: process.execPath, HOME: root, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_CONFIG_DIR: home,
    XDG_RUNTIME_DIR: `${root}/run`, XDG_CONFIG_HOME: `${root}/config`, XDG_CACHE_HOME: `${root}/cache`, XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`, TMPDIR: root, EXCALIDRAW_LOCAL_DIR: `${root}/love-spot`, EXCALIDRAW_SCREENSHOTS_DIR: shots, ELECTRON_OZONE_PLATFORM_HINT: 'x11' };
  const { ledgerBridge, ledgerMarketplace } = await import('./ledger-fixtures.mjs');
  const fixtures = await Promise.all(['codex', 'claude'].map(format => ledgerMarketplace(root, format)));
  let bridge, child, browser, server;
  const log = await fs.open(path.join(shots, baseline ? 'app-baseline.log' : 'app.log'), 'w');
  try {
    bridge = await ledgerBridge(root, binary, env);
    env.ELPIS_APP_BRIDGE_SOCKET = bridge.socketPath;
    if (baseline) {
      process.env = { ...env };
      const { DesktopClient } = await import('../bridge/client.mjs');
      const client = await DesktopClient.connect({ socketPath: bridge.socketPath });
      try {
        await client.changeMarketplace({ action: 'add', source: fixtures[0].market });
        await client.changePlugin({ action: 'install', id: `${fixtures[0].pluginName}@${fixtures[0].name}` });
      } finally { client.close(); }
    }
    let page;
    if (process.argv.includes('--browser')) {
      // A real-engine browser fallback is evidence of renderer behaviour, never packaged acceptance.
      process.env = { ...env };
      const { startDesktopServer } = await import('../bridge/server.mjs');
      server = await startDesktopServer({ staticDir: path.join(app, 'app/out'), socketPath: bridge.socketPath, elpisHome: home });
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
      await page.goto(server.url);
    } else {
      child = spawn('xvfb-run', ['-a', path.join(app, 'launch'), '--ozone-platform=x11', `--remote-debugging-port=${port}`, ...(process.argv.includes('--no-sandbox') ? ['--no-sandbox'] : [])], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
      for (let i = 0; ; i++) {
        if (await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.ok, () => false)) break;
        if (i > 150 || child.exitCode !== null) throw Error(`Packaged app did not open: ${await fs.readFile(path.join(shots, baseline ? 'app-baseline.log' : 'app.log'), 'utf8')}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      for (let i = 0; !page; i++) {
        page = browser.contexts().flatMap(context => context.pages())[0];
        if (i > 200 || child.exitCode !== null) throw Error(`No app window: ${await fs.readFile(path.join(shots, baseline ? 'app-baseline.log' : 'app.log'), 'utf8')}`);
        if (!page) await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    page.setDefaultTimeout(12000);
    const theme = async value => {
      if (await page.locator('html').evaluate(root => root.classList.contains('dark')) !== (value === 'dark')) await chooseTheme(page, value);
    };
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const ledger = async section => {
      await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click();
      await page.getByRole('radiogroup', { name: 'Customize', exact: true }).getByRole('radio', { name: section, exact: true }).click();
      await page.getByRole('region', { name: `Your ${section.toLowerCase()}`, exact: true }).waitFor();
    };
    const shot = async name => { await page.screenshot({ path: path.join(shots, `${baseline ? 'baseline-' : ''}${name}.png`) }); };
    const checked = async (name, enabled) => page.waitForFunction(({ name, enabled }) => [...document.querySelectorAll('[role="switch"]')].some(item => item.getAttribute('aria-label') === `Use ${name}` && item.getAttribute('aria-checked') === String(enabled) && !item.hasAttribute('data-disabled')), { name, enabled });
    console.log(`Throwaway home: ${root}`);
    if (baseline) {
      const missing = [];
      for (const mode of ['light', 'dark']) {
        await theme(mode);
        for (const section of ['Connectors', 'Plugins']) {
          await ledger(section); await shot(`${section.toLowerCase()}-${mode}`);
          if (section === 'Connectors' && !await page.getByRole('switch', { name: 'Use ledger', exact: true }).count()) missing.push(`${mode}: MCP switch missing`);
          if (section === 'Plugins' && !await page.getByRole('button', { name: 'Add plugins', exact: true }).count()) missing.push(`${mode}: Add plugins missing`);
        }
      }
      assert.deepEqual(missing, [], 'Unchanged CI renderer lacks the requested Customize controls');
      return;
    }
    await ledger('Connectors');
    const mcp = page.getByRole('switch', { name: 'Use ledger', exact: true });
    for (const enabled of [false, true]) {
      await mcp.click(); await checked('ledger', enabled);
      const config = await fs.readFile(path.join(home, 'config.toml'), 'utf8');
      assert.match(config.match(/\[mcp_servers\.ledger\]([^]*?)(?:\n\[|$)/)[1], new RegExp(`enabled = ${enabled}`));
      await page.reload(); await ledger('Connectors'); await checked('ledger', enabled);
    }
    await theme('light'); await shot('connectors-light'); await theme('dark'); await shot('connectors-dark'); await theme('light');
    for (const { market, name, pluginName } of fixtures) {
      await ledger('Plugins');
      const add = page.getByRole('button', { name: 'Add plugins', exact: true });
      if (await add.getAttribute('aria-expanded') !== 'true') await add.click();
      const catalog = page.getByRole('region', { name: 'Plugin catalog', exact: true });
      await catalog.getByRole('textbox', { name: 'Marketplace source', exact: true }).fill(market);
      await catalog.getByRole('button', { name: 'Add marketplace', exact: true }).click();
      await catalog.getByRole('button', { name: `Remove ${name}`, exact: true }).waitFor();
      const search = catalog.getByRole('textbox', { name: 'Search plugins', exact: true });
      await search.fill(pluginName); await search.press('Enter');
      await catalog.getByRole('button', { name: `Install ${pluginName}`, exact: true }).click();
      await catalog.getByText('Installed', { exact: true }).waitFor();
      for (const enabled of [false, true]) {
        await page.getByRole('switch', { name: `Use ${pluginName}`, exact: true }).click(); await checked(pluginName, enabled);
        assert.match(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), new RegExp(`\\[plugins\\."${pluginName}@${name}"\\]\\nenabled = ${enabled}`));
        await page.reload(); await ledger('Plugins'); await checked(pluginName, enabled);
      }
      await add.click();
      await shot(`plugins-${name}-light`); await theme('dark'); await shot(`plugins-${name}-dark`); await theme('light');
      await page.getByRole('button', { name: `Uninstall ${pluginName}`, exact: true }).click();
      await page.getByText('No plugins installed', { exact: true }).waitFor();
      await catalog.getByRole('button', { name: `Remove ${name}`, exact: true }).click();
      await catalog.getByText('No marketplaces added', { exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log('PASS: packaged app, MCP persistence after reload, both marketplace formats, install, off/on, uninstall, remove, light/dark');
  } finally {
    await browser?.close();
    await server?.close();
    if (child?.pid) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    await bridge?.close(); await log.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
