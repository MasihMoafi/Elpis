const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { fakeDesktop } = require('./fake-desktop.cjs');
const { guardDesktopStore } = require('./controls.cjs');
const exec = promisify(execFile);

async function loveSpotFixture({ colorScheme = 'light', reply = 'I am here with you.', replyDelay = 80 } = {}) {
  const base = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'love-spot-ui-'));
  const directory = path.join(root, 'drawing'), screenshots = path.join(root, 'Screenshots');
  await fs.mkdir(screenshots);
  const { startDesktopServer } = await import('../bridge/server.mjs');
  const emitter = new EventEmitter();
  const chats = [], turns = [], entries = [];
  const models = [
    { id: 'sol', model: 'sol', displayName: 'GPT-6.1-Sol', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] },
    { id: 'luna', model: 'luna', displayName: 'GPT-6-Luna', inputModalities: ['text', 'image'] },
    { id: 'text-only', model: 'text-only', displayName: 'Text only', inputModalities: ['text'] },
  ];
  Object.assign(emitter, { connected: true, pendingApprovals: [], close() {},
    settings: async () => ({ main: { model: 'sol', provider: 'openai' }, background: {}, smartPrune: { enabled: false, explicitOverride: {} }, memory: {}, write: { available: false, reason: '' }, agents: { graph: 256, atOnce: 4, source: 'agents.max_threads' } }),
    providerSettings: async () => ({ providers: [], version: null, write: { available: false } }),
    listThreads: async () => ({ data: chats, nextCursor: null }), models: async () => ({ data: models, nextCursor: null }),
    createThread: async body => {
      const thread = { id: 'love-chat', ...body, modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct', reason: null } }; chats.push(thread);
      emitter.emit('event', { type: 'message', data: { method: 'thread/started', params: { thread } } });
      return { thread };
    },
    readThread: async () => ({ thread: chats[0], data: [...entries].reverse(), nextCursor: null }),
    resume: async () => ({ thread: chats[0], activeTurnId: null }),
    send: async (id, body) => {
      const turn = { id: `turn-${turns.length + 1}` }; turns.push({ id, ...body });
      const prompt = { turnId: turn.id, item: { id: `user-${turn.id}`, type: 'userMessage', content: [{ type: 'text', text: body.text }] } }; entries.push(prompt);
      emitter.emit('event', { type: 'message', data: { method: 'turn/started', params: { threadId: id, turn } } });
      setTimeout(() => {
        const item = { id: `agent-${turn.id}`, type: 'agentMessage', text: reply };
        if (reply) { entries.push({ turnId: turn.id, item }); emitter.emit('event', { type: 'message', data: { method: 'item/completed', params: { threadId: id, turnId: turn.id, item } } }); }
        emitter.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: id, turn: { ...turn, status: reply ? 'completed' : 'failed', items: reply ? [item] : [], ...(!reply ? { error: { message: 'Test provider failed' } } : {}) } } } });
      }, replyDelay);
      return { turn };
    } });
  const client = new Proxy(emitter, { get(target, key) { return key in target ? Reflect.get(target, key) : async () => ({}); } });
  const server = await startDesktopServer({ client, loveSpot: { directory, screenshots }, trashFile: path.join(root, 'trash.json') });
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, colorScheme });
  const errors = [], requests = [], responses = [];
  const newPage = async () => {
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    await guardDesktopStore(page); await page.addInitScript(fakeDesktop);
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => requests.push(r.url()));
    page.on('response', r => responses.push({ url: r.url(), status: r.status() }));
    await page.goto(server.url); await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await page.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).waitFor();
    return page;
  };
  let page;
  try { page = await newPage(); } catch (e) { await browser.close(); await server.close(); await exec('gio', ['trash', root]); throw e; }
  const scene = async () => { try { return JSON.parse(await fs.readFile(path.join(directory, 'scene.excalidraw'), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { elements: [], files: {} }; throw e; } };
  const waitFor = async (check, message, timeout = 5000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { const drawing = await scene(); if (await check(drawing)) return drawing; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(message);
  };
  const open = async target => {
    try { await target.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).click(); await target.locator('.excalidraw canvas').first().waitFor(); await target.evaluate(() => document.fonts.load('20px Excalifont')); await target.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).blur(); }
    catch (e) { await target.screenshot({ path: '/tmp/love-spot-failure.png' }); throw new Error(`${e.message}; browser errors: ${JSON.stringify(errors)}; page: ${(await target.locator('body').innerText()).slice(0, 300)}`); }
  };
  const draw = async (target, offset = 0) => {
    await target.keyboard.press('Escape');
    const bounds = await target.locator('.excalidraw').boundingBox();
    await target.mouse.click(bounds.x + 450, bounds.y + 220);
    await target.keyboard.press('r');
    await target.mouse.move(bounds.x + 450 + offset, bounds.y + 220 + offset);
    await target.mouse.down(); await target.mouse.move(bounds.x + 550 + offset, bounds.y + 300 + offset, { steps: 8 }); await target.mouse.up();
    await target.keyboard.press('Escape');
  };
  return { page, newPage, open, draw, root, directory, screenshots, scene, waitFor, errors, requests, responses, chats, turns, emitter,
    async close() { await browser.close(); await server.close(); await exec('gio', ['trash', root]); } };
}
module.exports = { loveSpotFixture };
