// One subscription turn through a throwaway bridge and HOME. Never opens the installed desktop app.
// ELPIS_PLAYWRIGHT_PACKAGE=... ELPIS_CHROMIUM=... node tests/love-spot-talk.runtime.mjs /absolute/elpis-next
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { DesktopClient } from '../bridge/client.mjs';
import { startDesktopServer } from '../bridge/server.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fakeDesktop } = require('./fake-desktop.cjs');
const run = promisify(execFile);
// Opt-in dock eval: a configured external WhisperType command, real Chrome capture and ChatGPT transcription.
const voiceCommand = process.env.LOVE_DOCK_VOICE_COMMAND;
const voiceArgs = JSON.parse(process.env.LOVE_DOCK_VOICE_ARGS || '[]');
const engine = realpathSync(process.argv[2]);
const bridgeScript = path.join(path.dirname(engine), 'tools/elpis-claude/acp-bridge.mjs');
assert.ok(existsSync(bridgeScript));
const cache = path.join(process.env.HOME, '.cache/elpis-tests'); await fs.mkdir(cache, { recursive: true });
const root = await fs.mkdtemp(path.join(cache, 'love-talk-live-')), home = path.join(root, 'home'), elpisHome = path.join(home, '.elpis-next');
const runtime = await fs.mkdtemp('/tmp/lst-'), directory = path.join(home, 'Love Spot'), socketPath = path.join(runtime, 'bridge.sock');
await fs.mkdir(elpisHome, { recursive: true, mode: 0o700 }); await fs.mkdir(directory);
const auth = path.join(process.env.ELPIS_HOME || path.join(process.env.HOME, '.elpis-next'), 'auth.json');
await fs.copyFile(auth, path.join(elpisHome, 'auth.json')); await fs.chmod(path.join(elpisHome, 'auth.json'), 0o600);
await fs.writeFile(path.join(elpisHome, 'config.toml'), `model = "gpt-6-luna"\nmodel_provider = "openai"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[projects.${JSON.stringify(directory)}]\ntrust_level = "trusted"\n${voiceCommand ? `[mcp_servers.whispertype]\ncommand = ${JSON.stringify(voiceCommand)}\nargs = ${JSON.stringify(voiceArgs)}\nenabled = true\n[mcp_servers.whispertype.env]\nWHISPERTYPE_BACKEND = "codex"\n` : ''}`);
const env = { ...process.env, HOME: home, ELPIS_HOME: elpisHome, CODEX_HOME: elpisHome, CODEX_AUTH_HOME: elpisHome,
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'),
  ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath, ELPIS_ENGINE_BIN: engine, ACP_BRIDGE_STORE: path.join(root, 'provider-sessions.json'),
  ELPIS_NO_AGY: '1', NODE_USE_ENV_PROXY: '1' };
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
const log = await fs.open(path.join(root, 'bridge.log'), 'a');
const bridge = spawn(process.execPath, [bridgeScript], { cwd: home, env, stdio: ['ignore', log.fd, log.fd] });
const exited = once(bridge, 'exit');
let app, browser, page, submitted, failure;
const errors = [], consoleErrors = [];
const evidence = process.env.LOVE_DOCK_EVIDENCE || '/tmp/love-spot-talk-live'; await fs.mkdir(evidence, { recursive: true });
try {
  for (let i = 0; !existsSync(socketPath); i++) {
    if (bridge.exitCode !== null || i > 200) throw Error('The isolated provider bridge did not start.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const client = await DesktopClient.connect({ socketPath });
  const original = client.send.bind(client);
  client.send = (id, body) => { submitted = { threadId: id, model: body.model, notes: body.attachments.find(a => a.type === 'text')?.text, image: body.attachments.some(a => a.type === 'image') }; return original(id, body); };
  app = await startDesktopServer({ client, loveSpot: { directory, screenshots: path.join(root, 'Screenshots') }, trashFile: path.join(root, 'trash.json'), elpisHome });
  const wav = path.join(root, 'speech.wav'); let recordMs = 0;
  if (voiceCommand) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'flite=text=Read the secret phrase on the board. Reply with only the phrase.:voice=slt', '-ar', '16000', '-ac', '1', wav]);
    const duration = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wav]);
    recordMs = Math.ceil(Number(duration.stdout) * 1000) + 500;
  }
  browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true,
    args: voiceCommand ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] : [] });
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } }); page.setDefaultTimeout(20000);
  await page.addInitScript(fakeDesktop);
  page.on('pageerror', error => errors.push(error.stack || error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  const target = new URL(app.url); if (voiceCommand) target.pathname = '/love-spot.html';
  await page.goto(target.href);
  if (!voiceCommand) await page.getByRole('button', { name: 'Love Spot', exact: true }).click();
  await page.locator('.excalidraw canvas').first().waitFor();
  const record = async control => {
    await control.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await control.getByRole('button', { name: 'Stop recording and transcribe' }).waitFor();
    await page.waitForTimeout(recordMs); await control.getByRole('button', { name: 'Stop recording and transcribe' }).click();
  };
  await page.evaluate(() => document.fonts.load('20px Excalifont'));
  const bounds = await page.locator('.excalidraw').boundingBox();
  if (voiceCommand) {
    await page.mouse.click(bounds.x + 200, bounds.y + 430);
    await record(page.getByRole('group', { name: 'Voice note', exact: true }));
    for (let i = 0; ; i++) {
      const scene = JSON.parse(await fs.readFile(path.join(directory, 'scene.excalidraw'), 'utf8').catch(() => '{"elements":[]}'));
      if (scene.elements.some(e => e.strokeColor === '#2f9e44' && /read the secret phrase/i.test(e.originalText || e.text || ''))) break;
      assert.ok(i < 120, 'Captured speech did not become a green note');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  await page.mouse.click(bounds.x + 400, bounds.y + 300); await page.keyboard.press('t'); await page.mouse.click(bounds.x + 400, bounds.y + 300);
  const secret = `apricot lantern ${Math.random().toString(36).slice(2, 8)}`;
  await page.keyboard.type(`Our secret phrase is ${secret}`); await page.keyboard.press('Escape');
  for (let i = 0; ; i++) {
    const drawing = JSON.parse(await fs.readFile(path.join(directory, 'scene.excalidraw'), 'utf8').catch(() => '{"elements":[]}'));
    if (drawing.elements.some(e => (e.originalText || e.text || '').includes(secret))) break;
    assert.ok(i < 100, 'The test did not place its secret on the board');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await page.getByRole('button', { name: 'Talk', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Love Spot Talk', exact: true });
  if (voiceCommand) {
    await record(panel);
    await page.waitForFunction(() => /read the secret phrase/i.test(document.querySelector('.love-spot-talk textarea')?.value || ''), null, { timeout: 60000 });
    assert.equal(submitted, undefined, 'voice remains an editable draft until Send');
  } else await panel.getByRole('textbox', { name: 'Message Elpis' }).fill('Read our secret phrase from the board. Reply with only that entire phrase, without its introductory words. Do not use tools.');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  let scene;
  for (let i = 0; i < 180; i++) {
    scene = JSON.parse(await fs.readFile(path.join(directory, 'scene.excalidraw'), 'utf8'));
    if (scene.elements.some(e => e.id.startsWith('love-reply-'))) break;
    const alerts = await panel.getByRole('alert').allTextContents();
    if (alerts.length) throw Error(alerts.join('\n'));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  const reply = scene.elements.find(e => e.id.startsWith('love-reply-'));
  assert.ok(reply, 'No agent reply was placed on the board'); assert.ok(reply.originalText.includes(secret), 'The reply did not recall the board-only secret');
  assert.equal(reply.strokeColor, '#1971c2'); assert.equal(submitted.model, 'gpt-6-luna'); assert.equal(submitted.image, true); assert.ok(submitted.notes.includes(secret));
  await panel.getByText(reply.originalText, { exact: true }).waitFor();
  if (!voiceCommand) await page.locator(`aside [data-thread-id="${submitted.threadId}"] .thread-title`).filter({ hasText: 'Love Spot' }).waitFor();
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(evidence, 'live.png') });
  await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify({ passed: true, capturedVoice: !!voiceCommand, recordMs, root, submitted, reply: reply.originalText, colour: reply.strokeColor, errors, consoleErrors }, null, 2));
  process.stdout.write(`PASS: gpt-6-luna received the board text and PNG and replied on the board. Evidence: ${evidence}\n`);
} catch (cause) {
  failure = cause;
  await fs.writeFile(path.join(evidence, 'last-request.json'), JSON.stringify(submitted ?? null, null, 2));
  if (page) { await page.screenshot({ path: path.join(evidence, 'failure.png') }); await fs.writeFile(path.join(evidence, 'page.txt'), await page.locator('body').innerText()); }
  await fs.writeFile(path.join(evidence, 'failure.txt'), `${cause.stack}\nBrowser errors: ${errors.join('\n')}\nConsole: ${consoleErrors.join('\n')}\nIsolated bridge log: ${root}/bridge.log\n`);
} finally {
  await browser?.close(); await app?.close();
  if (bridge.exitCode === null) bridge.kill('SIGTERM');
  await exited; await log.close();
  // Retain evidence and throwaway chats; trash the temporary credential after shutting down its engine.
  await run('gio', ['trash', path.join(elpisHome, 'auth.json')]);
}
if (failure) throw failure;
