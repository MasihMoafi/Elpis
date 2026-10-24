// Permissions and effort for every chat, end to end: the packaged app, its own bridge and the real engine in a throwaway
// home, answering from a local stand-in for the model (no account, no inference). The config is Masih's shape: a
// full-access profile, effort high, and no approval policy (the engine alone would then ask).
// ELPIS_TEST_APP=/abs/packaged-app ELPIS_TEST_ENGINE=/abs/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=/abs/playwright \
//   [ELPIS_TEST_PORT=9473] [ELPIS_TEST_SHOTS=/abs/dir] node --test tests/permissions-effort.runtime.mjs
// The copy starts through ~/.cache/elpis-tests/e2e/app.sh (xvfb, own home, no session bus); ELPIS_E2E_APP_HELPER overrides it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chooseOption, controlValue, openSettings, leaveSettings, chooseTheme } = require('./controls.cjs');
const run = promisify(execFile);
const ready = !!(process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE);
const helper = process.env.ELPIS_E2E_APP_HELPER || path.join(os.homedir(), '.cache/elpis-tests/e2e/app.sh');
const port = process.env.ELPIS_TEST_PORT || '9473';

/** A Responses endpoint: "RUNCMD <file>" asks for one unsandboxed shell command that writes <file> (Ask must prompt
 * for it; Full access runs it); its output comes back quoted. Every request is kept, with its reasoning effort. */
function mockModel() {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [], models: [] })); return; }
      const req = JSON.parse(body || '{}'), items = (req.input ?? []).filter(item => item && typeof item === 'object');
      const users = items.filter(item => item.role === 'user').flatMap(item => (item.content ?? []).map(part => part.text ?? ''));
      const lastUser = users.at(-1) ?? '', last = items.at(-1) ?? {}, n = requests.length + 1;
      requests.push({ effort: req.reasoning?.effort ?? null, lastUser, answered: last.type === 'function_call_output' });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('response.created', { response: { id: `resp_${n}` } });
      const target = /RUNCMD (\S+)/.exec(lastUser)?.[1];
      const item = target && last.type !== 'function_call_output'
        ? { type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name: 'exec_command', arguments: JSON.stringify({ cmd: `echo ran > ${target}`, sandbox_permissions: 'require_escalated', justification: 'The test asks for this file.' }) }
        : { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: last.type === 'function_call_output' ? `tool finished ${n}` : `reply ${n}` }] };
      send('response.output_item.done', { item });
      send('response.completed', { response: { id: `resp_${n}`, usage: { input_tokens: 1000, input_tokens_details: null, output_tokens: 10, output_tokens_details: null, total_tokens: 1010 } } });
      response.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

/** The engine's own record of a chat's settings: the last turn context in its rollout. */
function engineSettings(home, id) {
  const files = []; const walk = dir => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith(`${id}.jsonl`)) files.push(file); } };
  walk(path.join(home, 'elpis/sessions'));
  assert.equal(files.length, 1, `one rollout for ${id}`);
  const contexts = readFileSync(files[0], 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(row => row.type === 'turn_context').map(row => row.payload);
  const last = contexts.at(-1);
  return { approval: last.approval_policy, profile: last.active_permission_profile?.id ?? null, sandbox: last.sandbox_policy?.type ?? null, effort: last.effort ?? null };
}

test('permissions and effort: Full access by default, Settings default, mid-chat changes, kept across switch, reload and restart', { skip: !ready, timeout: 600000 }, async t => {
  const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'perm-effort-')), shots = process.env.ELPIS_TEST_SHOTS || path.join(root, 'shots');
  // The commands write outside the chat's folder and outside /tmp, so only an unsandboxed run can make the file.
  const outside = await fs.mkdtemp(path.join(os.homedir(), '.cache', 'elpis-perm-out-'));
  await fs.mkdir(shots, { recursive: true });
  const mock = await mockModel();
  const seed = path.join(root, 'seed');
  await fs.mkdir(path.join(seed, 'work'), { recursive: true });
  await fs.writeFile(path.join(seed, 'config.toml'), ['model = "gpt-5.5"', 'model_provider = "mock"', 'model_reasoning_effort = "high"', 'approvals_reviewer = "user"', 'default_permissions = ":danger-full-access"', '',
    '[model_providers.mock]', 'name = "Mock"', `base_url = "http://127.0.0.1:${mock.port}/v1"`, 'wire_api = "responses"', ''].join('\n'));
  const env = { ...process.env, ELPIS_ENGINE_BIN: process.env.ELPIS_TEST_ENGINE };
  let home, browser, page;
  const start = async (seedDir, configSeed) => {
    const { stdout } = await run(helper, ['start', path.resolve(process.env.ELPIS_TEST_APP), port, seedDir], { env: { ...env, ...(configSeed ? { ELPIS_E2E_CONFIG_SEED: configSeed } : {}) }, timeout: 120000 });
    home = stdout.trim().split('\n').pop(); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('http://127.0.0.1'));
    assert.ok(page, 'the packaged app opens its renderer'); page.setDefaultTimeout(20000);
    await page.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
    await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 });
    const notNow = page.getByRole('button', { name: 'Not now', exact: true });
    await notNow.waitFor({ timeout: 4000 }).then(() => notNow.click(), () => {});
  };
  const stop = async () => { await browser?.close().catch(() => {}); if (home) await run(helper, ['stop', home]).catch(() => {}); };
  t.after(async () => { await stop(); mock.server.close(); await fs.rm(outside, { recursive: true, force: true }); });

  const composer = () => page.getByLabel('Message Elpis', { exact: true });
  const shownMode = () => page.getByRole('button', { name: 'Change permissions', exact: true }).getAttribute('aria-description');
  const shownEffort = () => controlValue(page.getByLabel('Reasoning effort', { exact: true }));
  // The approval card's choices are numbered rows; for an escalated command they are Allow once, Always allow and
  // "Deny and stop".
  const DENY = /^\s*\d*\s*Deny/;
  const deny = () => page.getByRole('button').filter({ hasText: DENY });
  const reply = text => page.getByText(text, { exact: true }).last();
  const chooseMode = async label => {
    await page.getByRole('button', { name: 'Change permissions', exact: true }).click();
    await page.getByRole('menuitem').filter({ hasText: label }).first().click();
    await page.waitForFunction(want => document.querySelector('[aria-label="Change permissions"]')?.getAttribute('aria-description') === want, label);
  };
  /** The turn has ended: the composer offers no Stop response. */
  const idle = () => page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'detached', timeout: 60000 });
  const say = async text => { const before = mock.requests.length; await composer().fill(text); await composer().press('Enter'); return before; };
  /** Sends RUNCMD for a new file; resolves with whether it ran without a prompt (true) or a prompt appeared (false). */
  const runCommand = async name => {
    const file = path.join(outside, name);
    await say(`RUNCMD ${file}`);
    const outcome = await Promise.race([
      deny().first().waitFor({ timeout: 60000 }).then(() => 'prompt'),
      (async () => { for (let i = 0; i < 600 && !existsSync(file); i++) await new Promise(resolve => setTimeout(resolve, 100)); return existsSync(file) ? 'ran' : 'neither'; })(),
    ]).catch(async error => { await page.screenshot({ path: path.join(shots, `failed-${name}.png`) }); throw new Error(`${error.message}\nbuttons: ${JSON.stringify((await page.getByRole('button').allTextContents()).slice(-30))}`); });
    if (outcome === 'prompt') { assert.equal(existsSync(file), false, `${name}: nothing runs before the answer`); await deny().first().click(); await deny().first().waitFor({ state: 'detached' }); }
    else { assert.equal(outcome, 'ran'); await reply(`tool finished ${mock.requests.length}`).waitFor().catch(() => {}); assert.equal(await deny().count(), 0, `${name}: no approval was asked`); }
    await idle();
    return outcome;
  };
  const currentId = () => page.evaluate(() => document.querySelector('.thread-row[aria-current="page"], .thread-row[aria-selected="true"], .thread-row.active')?.getAttribute('data-thread-id'));
  const newChat = async () => { await leaveSettings(page); await page.keyboard.press('Control+n'); await composer().waitFor(); };
  /** Sends a message; resolves with the reasoning effort of the model request that carried it. */
  const effortOf = async text => {
    await say(text);
    for (let i = 0; i < 300; i++) { const seen = mock.requests.find(request => request.lastUser === text); if (seen) { await idle(); return seen.effort; } await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.fail(`no model request carried "${text}"`);
  };

  await start(seed);

  let chatA, chatB;
  await t.test('a new chat starts in Full access: commands run without asking, and it is not Bypass', async () => {
    await newChat();
    const shown = await shownMode(), outcome = await runCommand('a1.txt');
    chatA = await currentId(); assert.ok(chatA, 'the new chat is selected');
    await page.screenshot({ path: path.join(shots, 'new-chat-light.png') });
    assert.equal(shown, 'Full access', 'the composer shows the default before the first message');
    assert.equal(outcome, 'ran');
    assert.deepEqual(engineSettings(home, chatA), { approval: 'never', profile: ':danger-full-access', sandbox: 'danger-full-access', effort: 'high' });
    assert.equal(await shownMode(), 'Full access', 'the composer shows the mode the engine reports');
  });

  await t.test('mid-chat: Full to Ask takes effect on the next tool call, and back to Full', async () => {
    await chooseMode('Ask for approval');
    assert.equal(await runCommand('a2.txt'), 'prompt');
    assert.deepEqual(engineSettings(home, chatA), { approval: 'on-request', profile: ':workspace', sandbox: 'workspace-write', effort: 'high' });
    await chooseMode('Full access');
    assert.equal(await runCommand('a3.txt'), 'ran');
    assert.equal(engineSettings(home, chatA).approval, 'never');
  });

  await t.test('mid-chat effort: the menu, /effort and Shift+Up/Down reach the next request', async () => {
    await chooseOption(page.getByLabel('Reasoning effort', { exact: true }), 'xhigh');
    assert.equal(await effortOf('effort from the menu'), 'xhigh');
    await composer().fill('/effort low'); await composer().press('Enter');
    await page.waitForFunction(() => true); await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await shownEffort(), 'low');
    assert.equal(await effortOf('effort from the command'), 'low');
    await composer().fill(''); await composer().press('Shift+ArrowUp'); await composer().press('Shift+ArrowUp');
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await shownEffort(), 'high');
    await chooseOption(page.getByLabel('Reasoning effort', { exact: true }), 'xhigh');
    assert.equal(await effortOf('effort from the keys, then the menu'), 'xhigh');
  });

  await t.test('Settings default switched to Ask: the next new chat asks; switched back, the next one runs', async () => {
    await openSettings(page, 'Configuration');
    await chooseOption(page.getByLabel('Default permissions', { exact: true }), 'ask');
    await page.getByRole('status').filter({ hasText: 'saved' }).first().waitFor();
    await page.screenshot({ path: path.join(shots, 'settings-default-light.png') });
    await chooseTheme(page, 'dark'); await openSettings(page, 'Configuration');
    await page.screenshot({ path: path.join(shots, 'settings-default-dark.png') });
    await chooseTheme(page, 'light');
    const config = readFileSync(path.join(home, 'elpis/config.toml'), 'utf8');
    assert.match(config, /^approval_policy = "on-request"$/m); assert.match(config, /^approvals_reviewer = "user"$/m); assert.match(config, /^default_permissions = ":workspace"$/m);
    await newChat();
    assert.equal(await shownMode(), 'Ask for approval');
    assert.equal(await runCommand('b1.txt'), 'prompt');
    chatB = await currentId();
    assert.equal(engineSettings(home, chatB).approval, 'on-request');
    await chooseOption(page.getByLabel('Reasoning effort', { exact: true }), 'low');
    await openSettings(page, 'Configuration');
    await chooseOption(page.getByLabel('Default permissions', { exact: true }), 'full');
    await page.getByRole('status').filter({ hasText: 'saved' }).first().waitFor();
    await newChat();
    assert.equal(await shownMode(), 'Full access');
    assert.equal(await runCommand('c1.txt'), 'ran');
  });

  const expectChat = async (id, mode, effort, label) => {
    await leaveSettings(page);
    await page.locator(`.thread-row[data-thread-id="${id}"]`).click();
    await page.waitForFunction(want => document.querySelector('[aria-label="Change permissions"]')?.getAttribute('aria-description') === want, mode).catch(() => {});
    assert.equal(await shownMode(), mode, `${label}: permissions`);
    assert.equal(await shownEffort(), effort, `${label}: effort`);
  };
  await t.test('each chat keeps its own permissions and effort after switching chats and a window reload', async () => {
    await expectChat(chatA, 'Full access', 'xhigh', 'switch to A');
    await expectChat(chatB, 'Ask for approval', 'low', 'switch to B');
    await page.reload(); await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 });
    await expectChat(chatA, 'Full access', 'xhigh', 'reload, A');
    await expectChat(chatB, 'Ask for approval', 'low', 'reload, B');
  });

  await t.test('after an app and engine restart, both chats keep them, and the next requests use them', async () => {
    const snapshot = path.join(root, 'restart');
    await browser.close().catch(() => {}); await run(helper, ['stop', home]); await new Promise(resolve => setTimeout(resolve, 4000));
    await fs.cp(path.join(home, 'elpis'), path.join(snapshot, 'elpis'), { recursive: true });
    await fs.cp(path.join(home, '.config'), path.join(snapshot, 'config'), { recursive: true });
    for (const file of ['elpis/app-server-control', 'elpis/thread-writer-locks', 'config/Elpis/SingletonLock', 'config/Elpis/SingletonSocket', 'config/Elpis/SingletonCookie']) await fs.rm(path.join(snapshot, file), { recursive: true, force: true });
    const oldHome = home; home = undefined;
    await start(path.join(snapshot, 'elpis'), path.join(snapshot, 'config'));
    // The rollouts keep their first home's paths; the settings live in them.
    await page.locator(`.thread-row[data-thread-id="${chatA}"]`).waitFor({ timeout: 60000 });
    await expectChat(chatA, 'Full access', 'xhigh', 'restart, A');
    assert.equal(await effortOf('after restart A'), 'xhigh');
    assert.equal(await runCommand('a4.txt'), 'ran');
    await expectChat(chatB, 'Ask for approval', 'low', 'restart, B');
    assert.equal(await effortOf('after restart B'), 'low');
    assert.equal(await runCommand('b2.txt'), 'prompt');
    assert.equal(engineSettings(home, chatB).approval, 'on-request');
    assert.equal(engineSettings(home, chatA).effort, 'xhigh');
    await page.screenshot({ path: path.join(shots, 'after-restart-light.png') });
    void oldHome;
  });
});
