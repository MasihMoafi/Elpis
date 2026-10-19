// One real ChatGPT subscription turn, then desktop/TUI admission parity on that thread.
// Usage: ELPIS_PLAYWRIGHT_PACKAGE=... ELPIS_CHROMIUM=... node tests/context-files.runtime.mjs /absolute/elpis-next
// All config, sessions and bridge state are isolated under /tmp. Never print credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { startDesktopServer } from '../bridge/server.mjs';
import { DesktopClient } from '../bridge/client.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { assertUiFit } = require('./ui-fit.cjs');
const engine = await fs.realpath(process.argv[2]);
const root = process.env.LEDGER_LIVE_REUSE ? await fs.realpath(process.env.LEDGER_LIVE_REUSE) : await fs.mkdtemp('/tmp/cd-');
assert.ok(root.startsWith('/tmp/cd-'), 'Reuse only this harness’s throwaway project');
const previous = process.env.LEDGER_LIVE_REUSE ? JSON.parse(await fs.readFile(path.join(root, 'result.json'), 'utf8')) : null;
if (previous) assert.ok(previous.checks.includes('real Luna subscription reply rendered'));
const home = path.join(root, 'home'), project = path.join(root, 'project'), runtime = await fs.mkdtemp(path.join(root, 'rt-'));
await fs.chmod(root, 0o700);
for (const folder of [home, project, runtime, path.join(home, 'memories'), path.join(home, 'rules')]) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
const sourceAuth = path.join(process.env.ELPIS_HOME || path.join(process.env.HOME, '.elpis-next'), 'auth.json');
const credentials = JSON.parse(await fs.readFile(sourceAuth, 'utf8'));
assert.ok(credentials.auth_mode === 'chatgpt' && credentials.tokens?.access_token, 'This check requires the ChatGPT subscription');
await fs.copyFile(sourceAuth, path.join(home, 'auth.json')); await fs.chmod(path.join(home, 'auth.json'), 0o600);
await fs.writeFile(path.join(home, 'memories/MEMORY.md'), 'Ledger parity memory.');
await fs.writeFile(path.join(home, 'rules/ledger-rule.md'), 'Keep answers brief.');
await fs.writeFile(path.join(project, 'AGENTS.md'), 'This is a throwaway Ledger parity project.');
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-6-luna"\nmodel_provider="openai"\nmodel_reasoning_effort="low"\ncli_auth_credentials_store="file"\napproval_policy="never"\nsandbox_mode="read-only"\n[features]\nautomatic_context_pruning=false\n[skills]\ndev_rule_roots=[${JSON.stringify(path.join(home, 'rules'))}]\n[memories]\ngenerate_memories=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, CODEX_SQLITE_HOME: home, ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: path.join(runtime, 'bridge.sock'), ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(root, 'store.json'), NODE_USE_ENV_PROXY: '1' };
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']) delete env[key];
Object.assign(process.env, { ELPIS_HOME: home, CODEX_HOME: home, CODEX_SQLITE_HOME: home });
const tmuxSocket = `ctxdesk-${process.pid}`, target = 'ledger';
const tmux = (...args) => execFileSync('tmux', ['-L', tmuxSocket, ...args], { encoding: 'utf8', env });
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 20000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await check()) return; await pause(200); } throw Error(`Timed out: ${label}`); }
const log = await fs.open(path.join(root, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [new URL('../../../tools/elpis-claude/acp-bridge.mjs', import.meta.url).pathname], { cwd: project, env, stdio: ['ignore', log.fd, log.fd] });
let app, client, browser, page, threadId, terminal = false;
const evidence = { root, engine, model: 'gpt-6-luna', checks: [] };
try {
  await until(async () => { try { await fs.stat(env.ELPIS_BRIDGE_SOCKET); return true; } catch { if (bridge.exitCode !== null) throw Error('Isolated bridge exited; see its log'); return false; } }, 'own bridge');
  client = await DesktopClient.connect({ socketPath: env.ELPIS_BRIDGE_SOCKET });
  app = await startDesktopServer({ client, elpisHome: home, loveSpot: { directory: path.join(root, 'drawing') } });
  await client.models();
  if (previous) { threadId = previous.threadId; await client.unarchiveThread(threadId, {}); await client.resume(threadId, {}); }
  else { const { thread } = await client.createThread({ cwd: project, model: 'gpt-6-luna', name: 'Ledger parity live' }); threadId = thread.id; }
  evidence.threadId = threadId;
  const workspaceKey = `project-${createHash('sha256').update(project).digest('hex').slice(0, 12)}`;
  const directory = path.join(home, 'context/workspaces', workspaceKey, 'threads', threadId);
  await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'ES.md'), 'Ledger live checkpoint.');
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(15000);
  if (!previous) await client.send(threadId, { text: 'Reply with exactly LEDGER_LIVE_OK. Do not use tools or edit files.', effort: 'low' });
  console.log(previous ? 'Reusing the completed Luna turn' : 'Luna turn submitted in isolated project');
  await page.goto(app.url); await page.getByRole('button', { name: 'Ledger parity live', exact: true }).click();
  await page.getByText('LEDGER_LIVE_OK', { exact: true }).waitFor({ timeout: 90000 }); evidence.checks.push('real Luna subscription reply rendered');
  const before = (await client.contextFiles(threadId)).files.find(file => file.path === path.join(home, 'rules/ledger-rule.md'));
  assert.ok(before?.selectable, 'Configured rule is a selectable engine source');
  await page.locator('[data-context-toggle]').click();
  const popup = page.getByRole('dialog', { name: 'Context window usage', exact: true });
  const rule = popup.getByRole('switch', { name: `Include ${before.name}`, exact: true }); await rule.waitFor();
  if (!before.included) { await rule.click(); await until(async () => await rule.getAttribute('aria-checked') === 'true', 'desktop inclusion'); }
  await rule.click();
  await until(async () => !(await client.contextFiles(threadId)).files.find(file => file.path === before.path).included, 'desktop exclusion');
  evidence.checks.push('desktop real click excludes engine source');
  const tuiArgs = [engine, 'resume', threadId, '--remote', `unix://${env.ELPIS_BRIDGE_SOCKET}`, '--elpis-local-bridge', '--no-alt-screen', '-C', project];
  tmux('new-session', '-d', '-s', target, '-c', project, '-x', '180', '-y', '55', tuiArgs.map(quote).join(' ')); terminal = true;
  const capture = () => tmux('capture-pane', '-p', '-t', target, '-S', '-70');
  await until(() => { const text = capture(); if (/Hooks need review/.test(text)) tmux('send-keys', '-t', target, 'Escape'); return /Ledger parity live|LEDGER_LIVE_OK/.test(text); }, 'TUI same chat');
  tmux('send-keys', '-t', target, 'M-c');
  await until(() => /ledger-rule\.md.*EXCLUDED/.test(capture()), 'desktop exclusion shown in TUI');
  await fs.writeFile(path.join(root, 'tui-desktop-excluded.txt'), capture()); evidence.checks.push('TUI Ledger shows desktop EXCLUDED on same thread');
  // Alt+C selects the first source. Arrow down follows the Ledger display order until this rule is selected.
  let selected = false;
  for (let index = 0; index < 25; index++) {
    if (/›\s+\[ \]\s+.*ledger-rule\.md/.test(capture())) { selected = true; break; }
    tmux('send-keys', '-t', target, 'Down'); await pause(150);
  }
  assert.ok(selected, 'TUI selected the excluded configured rule');
  tmux('send-keys', '-t', target, 'Space');
  await until(() => /ledger-rule\.md.*INCLUDED/.test(capture()), 'TUI inclusion');
  await fs.writeFile(path.join(root, 'tui-included.txt'), capture());
  await until(async () => await rule.getAttribute('aria-checked') === 'true', 'desktop refresh after TUI inclusion', 12000);
  evidence.checks.push('TUI Space includes rule; desktop open Ledger refreshes to INCLUDED');
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme }); await pause(200); await assertUiFit(popup, `Live Ledger ${colorScheme}`);
    await page.screenshot({ path: path.join(root, `desktop-${colorScheme}.png`) });
  }
  evidence.status = 'passed';
} catch (error) { if (terminal) { try { await fs.writeFile(path.join(root, 'tui-failure.txt'), tmux('capture-pane', '-p', '-t', target, '-S', '-100')); } catch {} } evidence.status = 'failed'; evidence.error = error.message; await page?.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {}); throw error; }
finally {
  if (terminal) { try { tmux('kill-server'); } catch {} }
  if (threadId && app) await client.archiveThread(threadId, {}).then(() => evidence.archived = true).catch(error => evidence.archiveError = error.message);
  await browser?.close(); await app?.close();
  bridge.kill('SIGTERM'); await until(() => bridge.exitCode !== null || bridge.signalCode !== null, 'bridge exit', 8000).catch(() => bridge.kill('SIGKILL'));
  await log.close();
  await fs.writeFile(path.join(home, 'auth.json'), '{}');
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence));
}
