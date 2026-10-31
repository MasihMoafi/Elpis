// The chat view's basics, end to end: the packaged app, its own bridge and the real engine in a throwaway home, with a
// local stand-in model (no account). Long chats are fixtures shaped like real rollouts (tests/seed-chats.cjs).
// ELPIS_TEST_APP=/abs/packaged-app ELPIS_TEST_ENGINE=/abs/elpis-next ELPIS_PLAYWRIGHT_PACKAGE=/abs/playwright \
//   [ELPIS_TEST_PORT=9481] [ELPIS_TEST_SHOTS=/abs/dir] node --test tests/chat-basics.runtime.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startApp, stopApp, skipFirstRun } = require('./real-app.cjs');
const { seedChats, seedLongChat } = require('./seed-chats.cjs');
const ready = !!(process.env.ELPIS_TEST_APP && process.env.ELPIS_TEST_ENGINE);
const port = process.env.ELPIS_TEST_PORT || '9481';

/** A Responses endpoint: "SLOW" in the message holds the reply until release(); every other message is answered at once. */
function mockModel() {
  const requests = [], held = [];
  const server = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [], models: [] })); return; }
      const req = JSON.parse(body || '{}'), users = (req.input ?? []).filter(item => item?.role === 'user').flatMap(item => (item.content ?? []).map(part => part.text ?? ''));
      const lastUser = users.at(-1) ?? '', n = requests.length + 1; requests.push(lastUser);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const finish = () => {
        send('response.created', { response: { id: `resp_${n}` } });
        send('response.output_item.done', { item: { type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: `reply to ${lastUser}` }] } });
        send('response.completed', { response: { id: `resp_${n}`, usage: { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 } } });
        response.end();
      };
      if (/SLOW/.test(lastUser)) held.push(finish); else finish();
    });
  });
  const release = () => { while (held.length) held.shift()(); };
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, release, port: server.address().port })));
}

test('chat view basics: a long saved chat opens with its messages and loads ten earlier per press', { skip: !ready, timeout: 600000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'chat-basics-')), seed = path.join(root, 'seed');
  const shots = process.env.ELPIS_TEST_SHOTS || path.join(root, 'shots'); await fs.mkdir(shots, { recursive: true });
  const mock = await mockModel();
  await fs.mkdir(seed, { recursive: true });
  await fs.writeFile(path.join(seed, 'config.toml'), ['model = "gpt-5.5"', 'model_provider = "mock"', 'approvals_reviewer = "user"', 'default_permissions = ":danger-full-access"', '',
    '[model_providers.mock]', 'name = "Mock"', `base_url = "http://127.0.0.1:${mock.port}/v1"`, 'wire_api = "responses"', ''].join('\n'));
  const long = seedLongChat(seed, { name: 'Long chat', turns: 45, tools: 3, minutesAgo: 1 });
  const ids = seedChats(seed, ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((name, index) => ({ key: name, name, text: `${name} question`, minutesAgo: 100 + index * 10 })));
  const app = await startApp({ app: path.resolve(process.env.ELPIS_TEST_APP), port, seed, engine: process.env.ELPIS_TEST_ENGINE });
  t.after(async () => { await stopApp(app); mock.server.close(); });
  const { page } = app; page.setDefaultTimeout(20000);
  await page.locator('.startup-splash').waitFor({ state: 'detached', timeout: 60000 }); await skipFirstRun(page);
  const row = id => page.locator(`.thread-row[data-thread-id="${id}"]`);
  /** The question numbers the transcript shows (not the sidebar or tab titles). */
  const questions = () => page.locator('.chat-content').evaluate(content => { const found = [], walk = document.createTreeWalker(content, NodeFilter.SHOW_TEXT); while (walk.nextNode()) { const match = /^Question (\d+)$/.exec(walk.currentNode.data.trim()); if (match) found.push(Number(match[1])); } return found; });
  const earlier = page.locator('.load-earlier-messages');
  const redBars = () => page.locator('.error-banner:not(.notice):not(.warning)').allInnerTexts();

  await t.test('load earlier: scrolling to the top brings about ten earlier messages, reading position kept, nothing left to load at the start', async () => {
    await row(long).locator('.thread-link').click();
    await page.getByText('Answer 45', { exact: true }).waitFor();
    const first = await questions();
    assert.ok(first.includes(45), `the last question shows: ${first}`);
    assert.ok(Math.min(...first) > 1, 'a long chat does not open with every message');
    await earlier.waitFor({ state: 'attached', timeout: 5000 });
    let shown = first;
    for (let press = 0; press < 10 && await earlier.count(); press++) {
      const top = Math.min(...shown);
      const anchor = page.locator('.chat-content').getByText(`Question ${top}`, { exact: true }).first();
      await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; });
      await page.locator('.chat-content').getByText(`Question ${top - 1}`, { exact: true }).first().waitFor();
      await page.waitForTimeout(300);
      const now = await questions(), added = Math.min(...shown) - Math.min(...now);
      assert.ok(added >= Math.min(9, top - 1) && added <= 12, `press ${press + 1} adds about ten earlier messages (added ${added}, from ${top})`);
      const [after, view] = await Promise.all([anchor.boundingBox(), page.locator('.chat-scroll').boundingBox()]);
      assert.ok(after.y >= view.y && after.y < view.y + view.height, `the reading position stays: the message he was at is still in view (${after.y} in ${view.y}..${view.y + view.height})`);
      shown = now;
    }
    assert.equal(Math.min(...shown), 1, 'the chat start is reached'); assert.equal(await earlier.count(), 0, 'nothing is left to load at the start');
    await page.screenshot({ path: path.join(shots, 'load-earlier.png') });
  });
});
