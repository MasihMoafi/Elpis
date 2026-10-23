// Actual desktop entry point + installed native runtime. Only inference and the
// OS folder chooser result are controlled local fixtures. No user profile/keys.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { existingSocket } from '../bridge/client.mjs';
const require = createRequire(import.meta.url);
const { chooseOption, chooseTheme, openSettings } = require('./controls.cjs');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { Provider, message } = require('../../../scripts/lib/mock-provider.js');
const binary = process.argv[2];
assert(binary && path.isAbsolute(binary));
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.ELPIS_JOURNEY_EVIDENCE || await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-project-journey-'));
await fs.mkdir(evidence, { recursive: true });
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-project-profile-'));
const home = path.join(root, 'home'), folder = path.join(root, 'A project with spaces');
const config = path.join(root, 'config'), protectedFile = path.join(root, 'approved-result.md');
for (const dir of [home, folder, config]) await fs.mkdir(dir);
const secret = `INPUT_${crypto.randomUUID()}`;
await fs.writeFile(path.join(folder, 'input.txt'), secret);
const provider = new Provider(); await provider.start();
const catalog = require('../../../codex-rs/models-manager/models.json');
await fs.writeFile(path.join(home, 'models.json'), JSON.stringify({ models: ['gpt-5.5','gpt-6-luna'].map(slug=>catalog.models.find(m=>m.slug===slug)) }));
await fs.writeFile(path.join(home, 'hooks.json'), '{}');
const mcpStub = path.join(root, 'private-mcp.cjs');
await fs.writeFile(mcpStub, `const readline = require('node:readline');
const lines = readline.createInterface({input:process.stdin});
lines.on('line', raw => { const m=JSON.parse(raw); if(m.id === undefined) return;
const result = m.method === 'initialize' ? {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'private-transcription-fixture',version:'1'}} : m.method === 'tools/list' ? {tools:[{name:'transcribe_audio',description:'Unused isolated test tool',inputSchema:{type:'object',properties:{}}}]} : {};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n'); });
`);

await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\napproval_policy="on-request"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Local journey fixture"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(folder)}]\ntrust_level="trusted"\n[mcp_servers.whispertype]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(mcpStub)}]\n[mcp_servers.whispertype.env]\nWHISPERTYPE_BACKEND="openrouter"\n`);
const socket = path.join(root, 'runtime.sock');
const runtime = spawn(binary, ['app-server', '--listen', `unix://${socket}`], { cwd: folder, env: {
  PATH: process.env.PATH, HOME: home, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, LANG: 'C.UTF-8',
}, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '', desktop, page, firstOrigin, created = 0, runtimeSocket;
runtime.stdout.on('data', data => logs += data); runtime.stderr.on('data', data => logs += data);
const exited = once(runtime, 'exit');
const errors = [], checks = [];
const launch = async (profile = config) => {
  desktop = await _electron.launch({ executablePath: path.join(appRoot, 'node_modules/electron/dist/electron'), args: [appRoot], cwd: appRoot, env: {
    PATH: process.env.PATH, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
    HOME: home, XDG_CONFIG_HOME: profile, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home,
    ELPIS_APP_BRIDGE_SOCKET: runtimeSocket, LANG: 'C.UTF-8',
  }, timeout: 30000 });
  page = await desktop.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.getByText('Local workspace', { exact: true }).waitFor();
};
const shot = name => page.screenshot({ path: path.join(evidence, name), fullPage: true });
try {
  for (let n = 0; n < 100; n++) {
    if (runtime.exitCode !== null) throw Error(logs);
    try { await fs.stat(socket); break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  await fs.chmod(socket, 0o600);
  runtimeSocket = await fs.realpath(socket);
  assert.equal(existingSocket(runtimeSocket), runtimeSocket);
  console.log(JSON.stringify({ stage: 'runtime-ready', root }));
  await launch(); firstOrigin = new URL(page.url()).origin;
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add project…', exact: true }).click();
  await page.getByLabel('Project name', { exact: true }).fill('Elpis journey');
  await page.getByLabel('Workspace directory', { exact: true }).fill(path.join(root, 'does-not-exist'));
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'folder is unavailable' }).waitFor();
  assert.equal(await page.getByLabel('Project name').inputValue(), 'Elpis journey');
  checks.push('Unavailable folder rejected without losing project input');
  await desktop.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  assert.equal(await page.getByLabel('Workspace directory').inputValue(), path.join(root, 'does-not-exist'));
  await desktop.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
  await page.getByRole('button', { name: 'Choose folder…', exact: true }).click();
  await page.waitForFunction(folder => document.querySelector('input[aria-label="Workspace directory"]').value === folder, folder);
  assert.equal(await page.getByLabel('Workspace directory').inputValue(), folder);
  assert.equal(await page.getByRole('alert').count(), 0, 'choosing a valid folder clears the old validation error');
  await shot('01-project-folder.png');
  const stateFile = await desktop.evaluate(({ app }) => `${app.getPath('userData')}/workspace.json`);
  assert(stateFile.startsWith(root + '/'), 'failure injection must stay inside the isolated test profile');
  await fs.mkdir(stateFile);
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Could not save Elpis workspace' }).waitFor();
  assert.equal(await page.getByLabel('Project name', { exact: true }).isVisible(), true, 'failed persistence must keep the project form open');
  assert.equal(await page.getByLabel('Project name').inputValue(), 'Elpis journey');
  assert.equal(await page.getByLabel('Workspace directory').inputValue(), folder);
  await fs.rename(stateFile, `${stateFile}.unavailable-fixture`);
  checks.push('Actual save failure retains the project form and exact input; retry persists after recovery');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).filter({ hasText: 'Elpis journey' }).waitFor();
  checks.push('Named project uses the native chooser route and keeps the exact folder');
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add project…', exact: true }).click();
  await page.getByLabel('Workspace directory').fill(folder);
  await page.getByLabel('Project name').fill('Accidental duplicate');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'already belongs to' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'already belongs to' }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).filter({ hasText: 'Elpis journey' }).waitFor();
  checks.push('Duplicate folder cannot create or silently rename an existing project; cancel keeps selection');
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/threads') created++; });
  await page.route('**/api/threads/*/turns', route => route.fulfill({ status: 503, json: { error: 'Local first-send failure' } }));
  await page.getByLabel('Message Elpis', { exact: true }).fill('Read input.txt and write the approved result.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Local first-send failure' }).waitFor();
  assert.equal(await page.getByLabel('Message Elpis').inputValue(), 'Read input.txt and write the approved result.');
  assert.equal(provider.requests.length, 0);
  await page.unroute('**/api/threads/*/turns');
  provider.actions.push(request => {
    const tool = request.tools.find(tool => ['exec_command', 'shell_command'].includes(tool.name));
    assert(tool);
    const code = `from pathlib import Path; s=Path('input.txt').read_text(); Path(${JSON.stringify(protectedFile)}).write_text(s); print(s)`;
    const cmd = `python3 -c '${code.replaceAll("'", "'\\''")}'`;
    return { type: 'function_call', id: 'fc_journey', call_id: 'journey_tool', name: tool.name,
      arguments: JSON.stringify({ [tool.name === 'exec_command' ? 'cmd' : 'command']: cmd, sandbox_permissions: 'require_escalated', justification: 'Write only the isolated test result after approval.' }) };
  }, message('Completed the local task.\n\n| Step | Result |\n| --- | --- |\n| Read input | Complete |\n| Write result | Complete |'));
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('heading', { name: 'Allow Elpis to run this command?', exact: true }).waitFor({ timeout: 30000 });
  await assert.rejects(fs.readFile(protectedFile));
  await shot('02-task-approval.png');
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page.getByText('Completed the local task.', { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await fs.readFile(protectedFile, 'utf8'), secret);
  assert.equal(created, 1, 'retry uses the first created conversation');
  assert.equal(provider.requests[0].body.model, 'gpt-5.5');
  checks.push('First-send failure preserves draft; retry uses the same chat', 'Actual native command waits for approval and reads the selected folder', 'Approved result matches the unique file input');
  // The command sits in its group's row (inside "Worked for" once the turn ends); opening them shows its output.
  for (const summary of await page.locator('.worked-for:not([open]) > summary').all()) await summary.click();
  for (const summary of await page.locator('.activity-group:not([open]) > summary').all()) await summary.click();
  await page.getByText(secret, { exact: true }).waitFor();
  await shot('03-task-result.png');
  const draft = 'Unsent follow-up\n\nمتن فارسی';
  await page.getByLabel('Message Elpis').fill(draft);
  await chooseTheme(page, 'dark');
  const settingsRequests = provider.requests.length;
  await page.getByLabel('Model', { exact: true }).click();
  await page.getByLabel('Search models', { exact: true }).fill('gpt-5.5');
  await page.getByRole('option').filter({ hasText: 'gpt-5.5' }).click();
  await page.getByLabel('Model', { exact: true }).click();
  await page.getByLabel('Search models', { exact: true }).waitFor();
  await shot('06-desktop-model-menu.png');
  await page.getByLabel('Search models', { exact: true }).press('Escape');
  // The route is chosen in Settings → Voice; this chat's provider has no transcription of its own, so the fallback speaks.
  await openSettings(page);
  await page.getByRole('tab', { name: 'Voice', exact: true }).click();
  await page.getByText('Advanced: transcription', { exact: true }).click();
  await page.getByLabel('Fallback transcription engine', { exact: true }).click();
  await page.getByRole('option', { name: 'Local WhisperType', exact: true }).waitFor();
  await shot('07-transcription-choice.png');
  await page.getByRole('option', { name: 'Local WhisperType', exact: true }).click();
  await page.getByLabel('Save transcription settings', { exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Transcription settings saved' }).waitFor();
  await page.getByRole('button', { name: 'Back to app', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('button[aria-label="Dictate message"]').title.includes('Local WhisperType'));
  assert.match(await fs.readFile(path.join(home, 'config.toml'), 'utf8'), /WHISPERTYPE_BACKEND\s*=\s*"local"/);
  assert.equal(await page.getByLabel('Message Elpis').inputValue(), draft);
  assert.equal(provider.requests.length, settingsRequests, 'model selection and transcription settings never send a message');
  checks.push('Actual desktop model search and native transcription config save work without recording or sending');
  await page.locator('.thread-row .thread-link').first().click();
  const before = provider.requests.length;
  await desktop.close(); desktop = null;
  await launch();
  assert.notEqual(new URL(page.url()).origin, firstOrigin);
  await page.getByText('Completed the local task.', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Message Elpis').inputValue(), draft);
  assert.equal(await page.locator('html').getAttribute('class'), 'dark');
  assert.equal(provider.requests.length, before, 'reopening must not send a message');
  await page.getByRole('button', { name: 'Choose workspace', exact: true }).filter({ hasText: 'Elpis journey' }).waitFor();
  await shot('04-reopened-work.png');
  checks.push('Desktop reopen on a different port restores selected project, chat, theme and exact draft without inference');
  await page.waitForFunction(() => document.querySelector('button[aria-label="Dictate message"]').title.includes('Local WhisperType'));
  checks.push('Transcription engine remains Local after desktop reopen');
  // An independent profile sees native history but cannot recover this profile's
  // draft/project. This is the negative control for native workspace recovery.
  await desktop.close(); desktop = null;
  await launch(path.join(root, 'clean-config'));
  assert.equal(await page.getByLabel('Message Elpis').inputValue(), '');
  assert.match(await page.getByRole('button', { name: 'Choose workspace', exact: true }).innerText(), /All projects/);
  assert.equal(await page.getByText('Completed the local task.', { exact: true }).count(), 0);
  assert.equal(provider.requests.length, before);
  checks.push('Negative control: a fresh desktop profile cannot recover the saved draft/project/chat selection');
  await desktop.close(); desktop = null;
  await launch();
  await page.getByText('Completed the local task.', { exact: true }).waitFor();
  const chooseProject = async name => { await page.getByRole('button', { name: 'Choose workspace', exact: true }).click(); await page.getByRole('menuitem', { name }).click(); };
  const draftIs = expected => page.waitForFunction(expected => document.querySelector('textarea[aria-label="Message Elpis"]').value === expected, expected);
  const sentBeforeSwitch = provider.requests.length;
  await chooseProject('All projects · default folder');
  await page.getByLabel('Message Elpis').fill('Unsent default-folder task');
  await chooseProject(/Elpis journey/); await draftIs('');
  await page.getByLabel('Message Elpis').fill('Unsent project-only task');
  await chooseProject('All projects · default folder'); await draftIs('Unsent default-folder task');
  await chooseProject(/Elpis journey/); await draftIs('Unsent project-only task');
  assert.equal(provider.requests.length, sentBeforeSwitch);
  checks.push('Switching projects keeps new-chat drafts separate and never sends a task');
  await page.locator('.thread-row .thread-link').filter({hasText:'Read input.txt and write the approved result.'}).click();
  await chooseOption(page.getByLabel('Model', {exact:true}), 'gpt-6-luna');
  await chooseOption(page.getByLabel('Reasoning effort', {exact:true}), 'high');
  assert.equal(await page.getByLabel('Reasoning effort', {exact:true}).getAttribute('data-value'), 'high');
  const selectedReply = request => {
    if (JSON.stringify(request.input).includes('CONTEXT CHECKPOINT')) { provider.actions.unshift(selectedReply); return message('Previous task completed; the user requested the selected model and effort.'); }
    return message('Selected model and effort were used.');
  };
  provider.actions.push(selectedReply);
  await page.getByLabel('Message Elpis').fill('Use the selected model and high reasoning.');
  await page.getByRole('button', {name:'Send message',exact:true}).click();
  await page.getByText('Selected model and effort were used.', {exact:true}).waitFor();
  assert.equal(provider.requests.at(-1).body.model, 'gpt-6-luna');
  assert.equal(provider.requests.at(-1).body.reasoning.effort, 'high');
  checks.push('Actual desktop keeps pending model and effort together and both reach native inference');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(720, 820));
  await shot('05-compact-project.png');
  assert.deepEqual(errors, []); if (provider.error) throw provider.error;
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ status: 'passed', root, checks, runtime: binary, source: appRoot, limits: ['Local scripted inference, not a live model quality check', 'Chooser result controlled; native dialog not visually assessed', 'App remains subject to Masih acceptance'] }, null, 2));
  console.log(JSON.stringify({ status: 'passed', evidence, checks }));
} finally {
  await desktop?.close(); provider.close(); runtime.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
  if (runtime.exitCode === null) { runtime.kill('SIGKILL'); await exited; }
  await fs.writeFile(path.join(evidence, 'runtime.log'), logs);
}
