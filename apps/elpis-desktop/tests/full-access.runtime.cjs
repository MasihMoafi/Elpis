// Packaged app + installed native engine, local Responses model and ACP fixture only.
// ELPIS_TEST_APP=/package ELPIS_TEST_ENGINE=/engine ELPIS_PLAYWRIGHT_PACKAGE=/playwright node --test tests/full-access.runtime.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');
const run = promisify(execFile);
const repo = path.resolve(__dirname, '../../..');
const ready = process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE;

test('inherited permissions follow Settings across restart; explicit Ask stays; GPT, Claude and helpers never ask by default', { skip: !ready, timeout: 300000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.cache/elpis-tests/full-access-'));
  const mock = spawn(process.execPath, [path.join(repo, 'tools/elpis-claude/test/mock-responses.mjs'), '0', root], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let app;
  t.after(async () => { await stopApp(app); mock.kill('SIGTERM'); await run('gio', ['trash', root]); });
  let output = ''; mock.stdout.on('data', b => { output += b; });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('mock did not start')), 10000); mock.stdout.on('data', () => { if (/listening (\d+)/.test(output)) { clearTimeout(timer); resolve(); } }); });
  const mockPort = /listening (\d+)/.exec(output)[1];
  // The mock prints its actual port, including when the OS allocates it.
  const seed = path.join(root, 'seed'), work = path.join(root, 'work');
  await fs.mkdir(seed); await fs.mkdir(work);
  await fs.writeFile(path.join(seed, 'config.toml'), `model="gpt-5.5"\nmodel_provider="mock"\ndefault_permissions=":danger-full-access"\n[model_providers.mock]\nname="Mock"\nbase_url="http://127.0.0.1:${mockPort}/v1"\nwire_api="responses"\n`);
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: seed, CODEX_HOME: seed, XDG_CONFIG_HOME: path.join(root, 'config'), XDG_RUNTIME_DIR: root };
  const seeding = run(process.env.ELPIS_TEST_ENGINE, ['exec', '--skip-git-repo-check', '-C', work, '-s', 'danger-full-access', '-c', 'approval_policy="on-request"', '--json', 'legacy TUI permission seed'], { env, timeout: 45000, maxBuffer: 2e6 });
  seeding.child.stdin.end();
  const seedRun = await seeding;
  const id = seedRun.stdout.split('\n').filter(Boolean).map(s => { try { return JSON.parse(s); } catch { return {}; } }).find(row => row.type === 'thread.started')?.thread_id;
  assert.ok(id, seedRun.stdout);
  const { DatabaseSync } = require('node:sqlite');
  for (const name of await fs.readdir(seed)) if (/^state_.*\.sqlite$/.test(name)) {
    const db = new DatabaseSync(path.join(seed, name));
    db.prepare('UPDATE threads SET source = ? WHERE id = ?').run('cli', id); db.close();
  }
  for (const file of await fs.readdir(path.join(seed, 'sessions'), { recursive: true })) if (file.endsWith(`${id}.jsonl`)) {
    const filePath = path.join(seed, 'sessions', file), rows = (await fs.readFile(filePath, 'utf8')).trim().split('\n').map(JSON.parse);
    const meta = rows.find(row => row.type === 'session_meta'); meta.payload.source = 'cli'; meta.payload.originator = 'codex-tui';
    await fs.writeFile(filePath, rows.map(JSON.stringify).join('\n') + '\n');
  }
  const extra = { ACP_ADAPTER: path.join(repo, 'tools/elpis-claude/test/fake-acp-agent.mjs'), ELPIS_NO_AGY: '1', FAKE_ACP_MODELS: 'haiku', FAKE_ACP_LOG: path.join(root, 'acp.jsonl') };
  app = await startApp({ app: process.env.ELPIS_TEST_APP, engine: process.env.ELPIS_TEST_ENGINE, port: Number(process.env.ELPIS_TEST_PORT || 9732), seed, env: extra });
  let page = app.page;
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 }); await skipFirstRun(page);
  const select = async tid => { await page.locator(`.thread-row[data-thread-id="${tid}"]`).first().click(); await page.getByLabel('Message Elpis', { exact: true }).waitFor(); };
  const mode = () => page.getByRole('button', { name: 'Change permissions', exact: true });
  const choose = async label => { await mode().click(); await page.getByRole('menuitem').filter({ hasText: label }).first().click(); await page.waitForFunction(label => document.querySelector('[aria-label="Change permissions"]')?.getAttribute('aria-description') === label, label); };
  const deny = () => page.getByRole('button').filter({ hasText: /^\s*\d*\s*Deny/ }).first();
  const command = async (tag, asks = false, claude = false) => {
    const file = path.join(root, tag);
    const text = `${claude ? '[permission] ' : ''}PERMISSION_FILE:${file}`;
    await page.getByLabel('Message Elpis', { exact: true }).fill(text); await page.getByLabel('Message Elpis', { exact: true }).press('Enter');
    if (asks) {
      const deadline = Date.now() + 30000;
      while (!await deny().isVisible()) {
        assert.equal(await fs.stat(file).then(() => true, () => false), false, `${tag}: command ran before approval`);
        assert.ok(Date.now() < deadline, `${tag}: approval was shown`);
        await new Promise(r => setTimeout(r, 50));
      }
      await assert.rejects(fs.stat(file)); await deny().click();
    }
    else if (claude) { await page.getByText(new RegExp(`permission: allow_once[\\s\\S]*${tag}`)).last().waitFor({ timeout: 30000 }); assert.equal(await deny().count(), 0); assert.equal(await fs.readFile(file, 'utf8'), 'permission-ran'); }
    else { await page.waitForFunction(async tag => { const r = await fetch('/api/threads?limit=100'); return r.ok; }, tag); const end = Date.now() + 45000; for (;;) { if (await fs.stat(file).then(() => true, () => false)) break; assert.equal(await deny().count(), 0, `${tag}: inherited Full access asked for approval`); assert.ok(Date.now() < end, `${tag}: command did not run`); await new Promise(r => setTimeout(r, 50)); } }
    await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached', timeout: 30000 });
    t.diagnostic(`${tag}: ${asks ? 'approval shown; command held' : 'command ran; no approval'}`);
  };
  await select(id);
  await command('legacy-full');
  assert.equal(await mode().getAttribute('aria-description'), 'Full access');
  await page.keyboard.press('Control+n'); await command('gui-full');
  const normal = await page.locator('.thread-row[aria-current="page"],.thread-row[aria-selected="true"],.thread-row.active').first().getAttribute('data-thread-id');
  await choose('Ask for approval'); await command('explicit-ask', true);
  const setDefault = async label => { await openSettings(page, 'Configuration'); await chooseOption(page.getByLabel('Default permissions', { exact: true }), { label }); await page.getByText('Default permissions saved.', { exact: false }).waitFor(); await leaveSettings(page); };
  await setDefault('Ask for approval'); await select(id); await command('inherited-ask', true);
  await setDefault('Full access'); await select(id); await command('inherited-full-again');
  await select(normal); await command('explicit-ask-kept', true);
  const { connectAppServer } = await import(path.join(repo, 'tools/elpis-claude/app-server-connection.mjs'));
  const { existingSocket } = await import(path.join(repo, 'apps/elpis-desktop/bridge/client.mjs'));
  const socket = existingSocket(undefined, { ELPIS_HOME: path.join(app.home, 'elpis'), XDG_RUNTIME_DIR: path.join(app.home, 'run') });
  const helper = connectAppServer({ url: `ws+unix://${socket}:/`, name: 'elpis-agents' });
  t.after(() => helper.close()); await helper.ready;
  const started = await helper.call('thread/start', { model: 'gpt-5.5', modelProvider: 'mock', cwd: work, elpisParentThreadId: id });
  assert.equal(started.approvalPolicy, 'never');
  assert.equal(started.sandbox.type, 'dangerFullAccess');
  assert.notEqual(started.activePermissionProfile?.id, ':bypass-permissions');
  const helperFile = path.join(root, 'helper-full'), helperRequests = [];
  helper.listeners.add(message => { if (message.id !== undefined && message.method) helperRequests.push(message); });
  await helper.call('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: `PERMISSION_FILE:${helperFile}`, text_elements: [] }] });
  const deadline = Date.now() + 30000;
  while (!await fs.stat(helperFile).then(() => true, () => false)) { assert.equal(helperRequests.length, 0, 'automatic helper never asks'); assert.ok(Date.now() < deadline, 'helper command ran'); await new Promise(r => setTimeout(r, 50)); }
  assert.equal(helperRequests.length, 0);
  await page.keyboard.press('Control+n');
  await page.getByRole('combobox', { name: 'Model', exact: true }).click();
  await page.getByRole('option').filter({ hasText: /haiku/i }).first().click();
  await command('claude-full', false, true);
  const claudeId = await page.locator('.thread-row.active').first().getAttribute('data-thread-id');
  const modes = (await fs.readFile(path.join(root, 'acp.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse).filter(x => x.method === 'session/set_mode');
  assert.ok(modes.some(x => x.params.modeId === 'default'), 'Full access uses Claude permission checks with automatic answers');
  assert.equal(modes.some(x => x.params.modeId === 'bypassPermissions'), false, 'Full access never selects Bypass');
  const oldHome = app.home; await stopApp(app);
  app = await startApp({ app: process.env.ELPIS_TEST_APP, engine: process.env.ELPIS_TEST_ENGINE, port: Number(process.env.ELPIS_TEST_PORT || 9732), env: { ...extra, ELPIS_E2E_HOME: oldHome } });
  page = app.page; await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 });
  await select(id); await command('restart-inherited'); await select(normal); await command('restart-explicit-ask', true);
  await select(claudeId); await command('restart-claude', false, true);
});
