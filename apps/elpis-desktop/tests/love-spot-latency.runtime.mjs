// Real renderer -> desktop HTTP bridge -> installed engine -> provider bridge -> scripted ACP model.
// ELPIS_LATENCY_ENGINE=/absolute/elpis-next node --test tests/love-spot-latency.runtime.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DesktopClient } from '../bridge/client.mjs';

const engine = process.env.ELPIS_LATENCY_ENGINE;
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const evidence = process.env.ELPIS_LATENCY_EVIDENCE
  ?? path.join(os.homedir(), '.cache/elpis-briefs/20261030/lovespot-perf');
const shots = process.env.ELPIS_LATENCY_SHOTS
  ?? path.join(os.homedir(), '.cache/elpis-briefs/20261030/shots/lovespot-perf');
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fakeDesktop } = require('./fake-desktop.cjs');

async function until(check, label, timeout = 20_000) {
  for (const end = Date.now() + timeout; Date.now() < end; await pause(20)) {
    const value = await check();
    if (value) return value;
  }
  throw Error(`Timed out: ${label}`);
}

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const stages = sample => ({
  rendererToBridge: sample.bridge - sample.send,
  bridgeToEngineSubmit: sample.engineSubmit - sample.bridge,
  engineSubmitToTurnStart: sample.turnStart - sample.engineSubmit,
  turnStartToFirstToken: sample.firstToken - sample.turnStart,
  firstTokenToScreen: sample.screen - sample.firstToken,
  total: sample.screen - sample.send,
});
const metrics = ['rendererToBridge', 'finishedTypingToBridge', 'bridgeToEngineSubmit',
  'engineSubmitToTurnStart', 'turnStartToFirstToken', 'firstTokenToScreen', 'total'];

test('Love Spot sidebar and Matilda small chat expose staged first-text latency', {
  skip: !engine,
  timeout: 180_000,
}, async t => {
  await fs.mkdir(evidence, { recursive: true });
  await fs.mkdir(shots, { recursive: true });
  const root = await fs.mkdtemp(path.join(evidence, 'run-'));
  const home = path.join(root, 'home');
  const drawing = path.join(root, 'drawing');
  await fs.mkdir(home);
  await fs.mkdir(drawing);
  await fs.writeFile(path.join(home, 'config.toml'), [
    'model = "claude/sonnet"',
    'model_provider = "openai"',
    'model_reasoning_effort = "low"',
    'approval_policy = "never"',
    'sandbox_mode = "workspace-write"',
    `model_catalog_json = ${JSON.stringify(path.join(repo, 'codex-rs/models-manager/models.json'))}`,
    '[features]',
    'code_mode = false',
    '',
  ].join('\n'));

  const socketPath = path.join(root, 'bridge.sock');
  const bridgeLog = await fs.open(path.join(root, 'bridge-process.log'), 'a');
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    ELPIS_HOME: home,
    CODEX_HOME: home,
    CODEX_AUTH_HOME: home,
    CODEX_SQLITE_HOME: home,
    XDG_CONFIG_HOME: root,
    XDG_RUNTIME_DIR: root,
    TMPDIR: root,
    ELPIS_SHARED_BRIDGE: '1',
    ELPIS_BRIDGE_SOCKET: socketPath,
    ELPIS_ENGINE_BIN: engine,
    ACP_ADAPTER: path.join(repo, 'tools/elpis-claude/test/fake-acp-agent.mjs'),
    ACP_BRIDGE_STORE: path.join(root, 'provider-sessions.json'),
    ACP_BRIDGE_LOG: path.join(root, 'provider-bridge.log'),
    ACP_BRIDGE_NO_AGENTS: '1',
    ELPIS_NO_AGY: '1',
    FAKE_ACP_LOG: path.join(root, 'fake-model.jsonl'),
    FAKE_ACP_MODELS: 'sonnet',
    FAKE_ACP_NAME: 'Matilda',
    FAKE_ACP_ANSWER: 'FAST_REPLY',
  };
  const bridge = spawn(process.execPath, [path.join(repo, 'tools/elpis-claude/acp-bridge.mjs')], {
    cwd: drawing,
    env,
    detached: true,
    stdio: ['ignore', bridgeLog.fd, bridgeLog.fd],
  });
  t.after(async () => {
    if (bridge.exitCode === null && bridge.signalCode === null) {
      const ended = once(bridge, 'exit');
      bridge.kill('SIGTERM');
      await Promise.race([ended, pause(3000)]);
    }
    try { process.kill(-bridge.pid, 'SIGKILL'); } catch {}
    await bridgeLog.close();
  });
  await until(() => existsSync(socketPath), 'provider bridge socket');

  const client = await DesktopClient.connect({ socketPath, appHome: root });
  t.after(() => client.close());
  const samples = [];
  let active;
  const originalSend = client.send.bind(client);
  client.send = (...args) => {
    if (active && active.engineSubmit === undefined) active.engineSubmit = Date.now();
    return originalSend(...args);
  };
  client.on('event', event => {
    if (!active || event.type !== 'message') return;
    const { method } = event.data;
    if (method === 'turn/started' && active.turnStart === undefined) active.turnStart = Date.now();
    if (method === 'item/agentMessage/delta' && active.firstToken === undefined) active.firstToken = Date.now();
    if (method === 'turn/completed' && active.turnComplete === undefined) active.turnComplete = Date.now();
  });
  await client.models();

  const arrivals = [];
  const createServer = http.createServer;
  http.createServer = function observed(listener) {
    return createServer.call(this, (request, response) => {
      if (request.method === 'POST' && (/^\/api\/love-spot\/talk$/.test(request.url)
        || /^\/api\/threads\/[^/]+\/turns$/.test(request.url))) arrivals.push({ url: request.url, at: Date.now() });
      return listener(request, response);
    });
  };
  const { startDesktopServer } = await import(`../bridge/server.mjs?latency=${Date.now()}`);
  const app = await startDesktopServer({
    client,
    staticDir: path.join(appRoot, 'out'),
    elpisHome: home,
    trashFile: path.join(root, 'trash.json'),
    loveSpot: { directory: drawing, screenshots: path.join(root, 'Screenshots') },
  });
  http.createServer = createServer;
  t.after(() => app.close());

  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  page.setDefaultTimeout(20_000);
  await page.addInitScript(fakeDesktop);
  const pageErrors = [], talkRequests = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  page.on('request', request => { if (request.url().includes('/api/love-spot/talk')) talkRequests.push({ at: Date.now(), method: request.method(), url: request.url() }); });
  t.after(() => console.log(JSON.stringify({ talkRequests, pageErrors })));
  await page.goto(app.url);
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Love Spot', exact: true }).click();
  await page.locator('.excalidraw canvas').first().waitFor();
  await page.getByRole('button', { name: 'Pin Matilda', exact: true }).click();
  await page.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const mini = page.getByRole('dialog', { name: 'Small chat with Matilda', exact: true });
  const miniComposer = mini.getByRole('textbox', { name: 'Message Matilda', exact: true });

  async function measure({ pathPattern, composer, message, selector }) {
    const sample = { path: pathPattern.source, message };
    active = sample;
    const arrival = arrivals.length;
    await composer.fill(message);
    await page.evaluate(({ message, selector }) => {
      const visible = () => [...document.querySelectorAll(selector)].filter(element => element.textContent?.trim()).length;
      const count = visible();
      window.__loveLatency = { message, count };
      const observer = new MutationObserver(() => {
        if (visible() > count && window.__loveLatency.screen === undefined) {
          window.__loveLatency.screen = performance.timeOrigin + performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    }, { message, selector });
    sample.send = Date.now();
    await composer.press('Enter');
    await until(() => arrivals.length > arrival && pathPattern.test(arrivals[arrival].url), `${pathPattern} reaches bridge`);
    sample.bridge = arrivals[arrival].at;
    sample.screen = await until(() => page.evaluate(() => window.__loveLatency?.screen), `${selector} reaches screen`, 30_000);
    await until(() => sample.firstToken, 'first reply token');
    assert.ok(sample.engineSubmit && sample.turnStart);
    samples.push({ ...sample, ...stages(sample) });
    active = undefined;
    return sample;
  }

  for (let n = 1; n <= 4; n++) {
    const message = `mini latency ${n}`;
    await measure({ pathPattern: /^\/api\/love-spot\/talk$/, composer: miniComposer, message, selector: '.matilda-mini-message[data-speaker="matilda"]' });
    await mini.getByText('Matilda is replying…', { exact: true }).waitFor({ state: 'detached' });
  }

  await page.getByRole('button', { name: 'Chat with Matilda', exact: true }).click();
  const canvas = page.locator('.excalidraw').first();
  const bounds = await canvas.boundingBox();
  for (let n = 1; n <= 4; n++) {
    const message = `board latency ${n}`;
    const sample = { path: '/api/love-spot/talk', message };
    active = sample;
    const arrival = arrivals.length;
    await page.mouse.click(bounds.x + 250, bounds.y + 120 + n * 100);
    await page.keyboard.press('t');
    await page.mouse.click(bounds.x + 250, bounds.y + 120 + n * 100);
    await page.keyboard.type(message);
    sample.send = Date.now();
    await page.keyboard.press('Escape');
    await until(() => arrivals.length > arrival && /^\/api\/love-spot\/talk$/.test(arrivals[arrival].url), 'finished board note reaches bridge', 15_000);
    sample.bridge = arrivals[arrival].at;
    await until(() => sample.firstToken, 'first board reply token');
    await until(() => sample.turnComplete, 'board turn completes');
    await until(async () => !(await page.evaluate(() => fetch('/api/love-spot/talk').then(response => response.json()))).busy, 'board turn settles');
    assert.ok(sample.engineSubmit && sample.turnStart);
    samples.push({ ...sample,
      finishedTypingToBridge: sample.bridge - sample.send,
      bridgeToEngineSubmit: sample.engineSubmit - sample.bridge,
      engineSubmitToTurnStart: sample.turnStart - sample.engineSubmit,
      turnStartToFirstToken: sample.firstToken - sample.turnStart,
    });
    active = undefined;
  }

  const thread = await until(async () => (await client.listThreads({ limit: 100 })).data.find(item => item.name === 'Love Spot'), 'Love Spot thread');
  await page.locator(`.thread-row[data-thread-id="${thread.id}"] .thread-link`).first().click();
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  for (let n = 1; n <= 4; n++) {
    const message = `sidebar latency ${n}`;
    await measure({ pathPattern: /^\/api\/threads\/[^/]+\/turns$/, composer, message, selector: '.message.agent' });
  }

  const grouped = Object.groupBy(samples, sample => sample.message.split(' ')[0]);
  const medians = Object.fromEntries(Object.entries(grouped).map(([name, values]) => [name,
    Object.fromEntries(metrics.filter(key => values.every(value => Number.isFinite(value[key])))
      .map(key => [key, median(values.slice(1).map(value => value[key]))]))]));
  const result = { engine, root, samples, medians, pageErrors };
  await fs.writeFile(path.join(evidence, 'latest.json'), `${JSON.stringify(result, null, 2)}\n`);
  assert.ok(medians.board.finishedTypingToBridge < 750, `board waited ${medians.board.finishedTypingToBridge} ms after typing finished`);
  assert.ok(medians.mini.firstTokenToScreen < 250, `small chat hid the first token for ${medians.mini.firstTokenToScreen} ms`);
  assert.ok(grouped.mini.every(sample => sample.firstTokenToScreen < 250), 'the first small-chat reply also bypasses the one-second fallback');
  assert.ok(medians.sidebar.total < 500, `sidebar reply took ${medians.sidebar.total} ms without model latency`);
  for (const colorScheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme });
    await page.screenshot({ path: path.join(shots, `after-${colorScheme}.png`) });
  }
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify(result));
});
