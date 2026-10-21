// A124 real-app check. No credentials, copies of personal data, installs or builds.
// Run on the host (the worker sandbox cannot start Electron or the native socket):
// ELPIS_PLAYWRIGHT_PACKAGE=$HOME/.cache/elpis-tests/pw/node_modules/playwright \
// node tests/claude-turn-delivery-real.cjs --app /tmp/a124-app \
//   --bridge /path/to/tools/elpis-claude/acp-bridge.mjs --engine /path/to/elpis-next
// Use the installed app/bridge first, then the candidate. Default deliberately loses live
// final events; --normal exercises late steering acknowledgements instead.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { parseArgs } = require('node:util');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE);
const { values } = parseArgs({ options: { app: { type: 'string' }, bridge: { type: 'string' }, engine: { type: 'string' }, port: { type: 'string', default: '9464' }, normal: { type: 'boolean' } } });
for (const key of ['app', 'bridge', 'engine']) assert.ok(values[key] && path.isAbsolute(values[key]), `--${key} must be an absolute path`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a124-app-'));
const run = path.join(root, 'run'); fs.mkdirSync(run, { mode: 0o700 });
const socket = path.join(run, 'bridge.sock'), agentLog = path.join(root, 'agent.jsonl');
const tools = path.resolve(__dirname, '../../../tools/elpis-claude');
const release = path.join(root, 'release'), toolRelease = path.join(root, 'tools');
const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: path.join(root, 'elpis'), CODEX_HOME: path.join(root, 'elpis'), CODEX_AUTH_HOME: path.join(root, 'elpis'),
  ELPIS_CONFIG_DIR: path.join(root, 'elpis'), XDG_CONFIG_HOME: path.join(root, '.config'), XDG_CACHE_HOME: path.join(root, '.cache'), XDG_DATA_HOME: path.join(root, '.local/share'),
  XDG_STATE_HOME: path.join(root, '.local/state'), XDG_RUNTIME_DIR: run, TMPDIR: root, ELPIS_ENGINE_BIN: values.engine, ELPIS_NO_AGY: '1', ACP_BRIDGE_NO_AGENTS: '1',
  ACP_ADAPTER: path.join(tools, 'test/fake-acp-agent.mjs'), ACP_BRIDGE_STORE: path.join(root, 'sessions.json'), ACP_BRIDGE_LOG: path.join(root, 'bridge.log'),
  FAKE_ACP_LOG: agentLog, FAKE_ACP_NAME: 'Claude', FAKE_ACP_MODELS: 'sonnet', FAKE_ACP_RELEASE: release, FAKE_ACP_TOOL_RELEASE: toolRelease, FAKE_ACP_STEER_DELAY: '120' };
const children = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, why, ms = 15000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (await check()) return;
  throw new Error(why);
}
const records = () => fs.existsSync(agentLog) ? fs.readFileSync(agentLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
function start(command, args, extra, log) {
  const fd = fs.openSync(path.join(root, log), 'a');
  const child = spawn(command, args, { cwd: root, env: { ...env, ...extra }, detached: true, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd); children.push(child); return child;
}

(async () => {
  let browser, page;
  try {
    start(process.execPath, [values.bridge], { ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socket }, 'provider.log');
    await until(() => fs.existsSync(socket) && (fs.statSync(socket).mode & 0o777) === 0o600, 'provider bridge did not listen');
    start('xvfb-run', ['-a', path.join(values.app, 'launch'), '--ozone-platform=x11', `--remote-debugging-port=${values.port}`], { ELPIS_APP_BRIDGE_SOCKET: socket }, 'app.log');
    await until(async () => {
      try { return (await fetch(`http://127.0.0.1:${values.port}/json/list`)).ok; } catch { return false; }
    }, 'Electron did not start; see app.log');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${values.port}`);
    await until(() => { page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://127.0.0.1')); return page; }, 'desktop page did not load');
    page.setDefaultTimeout(15000);
    const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    await composer.waitFor();
    await page.getByRole('combobox', { name: 'Model', exact: true }).click();
    await page.locator('[role="option"][data-value="claude/sonnet"]').click();
    const initial = `[wait] [tool-flight] ${values.normal ? '' : '[record-only] '}A124 original`;
    const send = async text => {
      await composer.fill(text); await composer.press('Enter');
      await page.locator('.message.user').filter({ hasText: text }).waitFor();
    };
    await send(initial);
    await until(() => records().some(row => row.method === 'session/prompt'), 'the first prompt did not reach Claude');
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor();
    for (const text of ['a folder path', "maybe you don't even need to login"]) await send(text);
    assert.equal(records().filter(row => row.method === '_session/steering').length, 0, 'the running tool must finish before steering');
    fs.writeFileSync(toolRelease, '');
    await until(() => records().filter(row => row.method === '_session/steering').length === 2, 'both messages must reach Claude');
    fs.writeFileSync(release, '');
    await until(() => records().some(row => row.ended), 'Claude did not record its final answer');
    // This click is the required catch-up read, and also checks persisted message order.
    await page.getByRole('button', { name: 'Refresh conversation', exact: true }).click();
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.message.agent').filter({ hasText: 'answered:' }).waitFor();
    assert.deepEqual((await page.locator('.message.user').allTextContents()).map(text => text.trim()), [initial, 'a folder path', "maybe you don't even need to login"]);
    await send('hello?');
    await page.locator('.message.agent').filter({ hasText: 'answered: hello?' }).waitFor();
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
    await page.reload(); await composer.waitFor();
    await page.locator('.message.agent').filter({ hasText: 'answered: hello?' }).waitFor();
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: path.join(root, `${colorScheme}.png`) });
    }
    console.log(`PASS A124 ${values.normal ? 'normal' : 'lost-events'}: answers in order, idle, hello, reload; ${root}`);
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
    console.error(`FAIL A124: ${error.message}\nEvidence: ${root}`); process.exitCode = 1;
  } finally {
    await browser?.close();
    for (const child of children.reverse()) {
      if (child.exitCode === null && child.signalCode === null) {
        const ended = once(child, 'exit');
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        await Promise.race([ended, sleep(1500)]);
      }
      // xvfb-run can exit before its Xvfb/Electron children; the group is owned by this check.
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
