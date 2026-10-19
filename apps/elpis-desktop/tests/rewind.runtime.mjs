// Real native turns, bridge snapshots and browser interactions. Inference comes only from the local provider fixture.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { DesktopClient } from '../bridge/client.mjs';
import { startDesktopServer } from '../bridge/server.mjs';
import { chooseOption } from './controls.cjs';
const require = createRequire(import.meta.url);
const { Provider, message } = require('../../../scripts/lib/mock-provider.js');
const { fakeDesktop } = require('./fake-desktop.cjs');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const root = await fs.mkdtemp(path.resolve('../../.tmp/rewind/native-'));
const home = path.join(root, 'home'), cwd = path.join(root, 'work'); await fs.mkdir(home); await fs.mkdir(cwd);
const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
await fs.writeFile(path.join(cwd, 'code.txt'), 'committed\n'); git('add', 'code.txt'); git('commit', '-qm', 'baseline');
const provider = new Provider(); await provider.start();
const catalog = require('../../../codex-rs/models-manager/models.json');
await fs.writeFile(path.join(home, 'models.json'), JSON.stringify({ models: catalog.models.filter(model => model.slug === 'gpt-5.5') }));
await fs.writeFile(path.join(home, 'hooks.json'), '{}');
await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\napproval_policy="never"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Rewind test"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`);
const socketPath = path.join(root, 'runtime.sock');
const runtimeDir = path.resolve('../../.tmp/run'); await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
const child = spawn(path.resolve('../../codex-rs/target/dev-small/codex'), ['app-server', '--listen', `unix://${socketPath}`], { cwd,
  env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home, XDG_RUNTIME_DIR: runtimeDir, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(child, 'exit'); let logs = '', app, browser, client;
child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
try {
  for (let n = 0; n < 100; n++) { if (child.exitCode !== null) throw Error(logs); if (await fs.stat(socketPath).catch(() => null)) break; await new Promise(resolve => setTimeout(resolve, 100)); }
  await fs.chmod(socketPath, 0o600);
  client = await DesktopClient.connect({ socketPath: await fs.realpath(socketPath), rewindHome: path.join(home, 'rewind') });
  app = await startDesktopServer({ client, trashFile: path.join(home, 'trash.json'), elpisHome: home });
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.setDefaultTimeout(15000); await page.addInitScript(fakeDesktop);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const head = git('rev-parse', 'HEAD'), index = git('show', ':code.txt');
  for (const mode of ['both', 'conversation', 'code']) {
    const created = await client.createThread({ cwd, name: `Rewind native ${mode}` });
    await fs.writeFile(path.join(cwd, 'code.txt'), `dirty before first ${mode}\n`);
    provider.actions.push(message(`FIRST_REPLY_${mode}`));
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { client.off('event', completed); reject(Error('First turn did not finish.')); }, 30000);
      const completed = event => { if (event.data?.method === 'turn/completed' && event.data.params.threadId === created.thread.id) { clearTimeout(timeout); client.off('event', completed); resolve(); } };
      client.on('event', completed); client.send(created.thread.id, { text: `FIRST_${mode}` }).catch(reject);
    });
    await page.goto(app.url); await page.locator(`.thread-row[data-thread-id="${created.thread.id}"] .thread-link`).click();
    const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    const send = async (prompt, reply) => { provider.actions.push(message(reply)); await composer.fill(prompt); await composer.press('Enter'); await page.getByText(reply, { exact: true }).waitFor({ timeout: 30000 }); await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' }); };
    await page.getByText(`FIRST_REPLY_${mode}`, { exact: true }).waitFor(); await fs.writeFile(path.join(cwd, 'code.txt'), `before second ${mode}\n`);
    await send(`SECOND_${mode}`, `SECOND_REPLY_${mode}`); await fs.writeFile(path.join(cwd, 'code.txt'), `after second ${mode}\n`);
    await page.locator('.message.user', { hasText: `SECOND_${mode}` }).click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Rewind to here', exact: true }).click();
    const dialog = page.getByRole('alertdialog'); await chooseOption(dialog.getByLabel('Restore', { exact: true }), { label: { both: 'Code and conversation', conversation: 'Conversation only', code: 'Code only' }[mode] });
    await dialog.getByRole('button', { name: 'Rewind', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await fs.readFile(path.join(cwd, 'code.txt'), 'utf8'), mode === 'conversation' ? `after second ${mode}\n` : `before second ${mode}\n`);
    if (mode === 'code') await page.getByText(`SECOND_REPLY_${mode}`, { exact: true }).waitFor();
    else {
      await page.getByText(`SECOND_REPLY_${mode}`, { exact: true }).waitFor({ state: 'hidden' });
      if (mode === 'both') {
        const current = await page.locator('.thread-row.active').getAttribute('data-thread-id');
        await app.close(); client = await DesktopClient.connect({ socketPath: await fs.realpath(socketPath), rewindHome: path.join(home, 'rewind') });
        app = await startDesktopServer({ client, trashFile: path.join(home, 'trash.json'), elpisHome: home });
        await page.goto(app.url); await page.locator(`.thread-row[data-thread-id="${current}"] .thread-link`).click();
      }
      await page.getByRole('button', { name: 'Undo rewind', exact: true }).click(); await page.getByText(`SECOND_REPLY_${mode}`, { exact: true }).waitFor();
      const kept = await fs.readFile(path.join(cwd, 'code.txt'), 'utf8');
      await page.getByRole('button', { name: 'Redo rewind', exact: true }).click(); await page.getByText(`SECOND_REPLY_${mode}`, { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await fs.readFile(path.join(cwd, 'code.txt'), 'utf8'), kept);
      await send(`CONTINUED_${mode}`, `CONTINUED_REPLY_${mode}`);
      assert.doesNotMatch(JSON.stringify(provider.requests.at(-1).body.input), new RegExp(`SECOND_${mode}`));
      await page.getByRole('button', { name: 'Undo rewind', exact: true }).waitFor({ state: 'hidden' });
    }
    assert.equal(git('rev-parse', 'HEAD'), head); assert.equal(git('show', ':code.txt'), index);
    console.log(`PASS native ${mode}: snapshot, transcript, history continuation, HEAD/index`);
  }
  assert.deepEqual(errors, []); console.log(JSON.stringify({ status: 'passed', modes: 3, providerRequests: provider.requests.length, root }));
} catch (error) { if (browser) await browser.contexts()[0]?.pages()[0]?.screenshot({ path: path.join(root, 'failure.png') }); throw new Error(`${error.stack}\n${logs.slice(-4000)}`); }
finally { await browser?.close(); await app?.close(); client?.close(); child.kill('SIGTERM'); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]); if (child.exitCode === null) child.kill('SIGKILL'); await provider.close(); }
