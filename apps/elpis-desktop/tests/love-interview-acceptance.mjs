// Run under xvfb-run with a packaged app and its provider tools. No UI or bridge mocks.
// ELPIS_PLAYWRIGHT_PACKAGE=... xvfb-run -a node tests/love-interview-acceptance.mjs APP TOOLS EVIDENCE
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { interviewRuntime } from './love-interview-runtime.mjs';
import { runAcpNode } from '../bridge/acp-nodes.mjs';

const [appDirectory, toolsDirectory, evidence] = process.argv.slice(2);
const { _electron } = createRequire(import.meta.url)(process.env.ELPIS_PLAYWRIGHT_PACKAGE);
await fs.mkdir(evidence, { recursive: true });
const f = await interviewRuntime({ toolsDirectory, seed: false });
let app, page;
// Native capture preserves the full window at Elpis's 110% zoom (CDP screenshots crop its right edge).
const capture = async name => {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(50);
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await fs.writeFile(path.join(evidence, name), Buffer.from(png, 'base64'));
};
const checks = [];
const check = label => { checks.push(label); console.log(`PASS ${label}`); };
const until = async predicate => { for (const end = Date.now() + 15000; Date.now() < end;) { if (await predicate()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('Interview condition timed out'); };
try {
  const launch = () => _electron.launch({ executablePath: path.join(appDirectory, 'runtime/electron/electron'), args: [path.join(appDirectory, 'app'), '--ozone-platform=x11'],
    env: { ...f.env, DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY, ELPIS_APP_BRIDGE_SOCKET: f.socketPath, ELPIS_ACP_AGENT: path.join(toolsDirectory, 'elpis-acp-agent.mjs'), EXCALIDRAW_LOCAL_DIR: path.join(f.root, 'drawing'), EXCALIDRAW_SCREENSHOTS_DIR: path.join(f.root, 'shots'), TMPDIR: f.root, ELECTRON_OZONE_PLATFORM_HINT: 'x11', WAYLAND_DISPLAY: '', ELECTRON_RUN_AS_NODE: '' }, timeout: 20000 });
  app = await launch();
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 1080));
  await page.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).click();
  await page.locator('.excalidraw canvas').first().waitFor();
  await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add Writer', exact: true }).click();
  let panel = page.getByLabel('Agent details', { exact: true });
  const log = () => panel.getByRole('log');
  const input = () => panel.getByRole('textbox', { name: 'Reply to Writer', exact: true });
  await panel.getByText('What would you like to write?', { exact: true }).waitFor();
  await capture('first-question.png');
  const chats = await f.client.listThreads();
  if (chats.data.length) {
    await page.getByText('Love Spot · Writer', { exact: true }).first().click();
    await page.getByText('Continue the interview. Conversation:', { exact: false }).first().waitFor();
    await capture('leaked-chat.png');
    assert.doesNotMatch(await page.locator('body').innerText(), /Continue the interview|Conversation:|\{"question"/, 'the chat must not display an invented user prompt or raw interview JSON');
  }
  assert.doesNotMatch(JSON.stringify(chats), /Continue the interview|Conversation:|\\"question\\"/);
  assert.equal(chats.data.length, 0); check('empty conversation asks one plain agent question; chat list stays empty');
  const firstCalls = f.requests.filter(r => r.method === 'turn/start').length;
  await panel.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Inspect Writer', exact: true }).click();
  await panel.getByText('What would you like to write?', { exact: true }).waitFor();
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, firstCalls); check('reopening saves and asks once');
  f.answer('{"question":"Who will read it?"}'); f.hold();
  await input().fill('A letter about the garden.'); await input().press('Enter');
  await until(async () => (await f.agent()).interview.messages.some(m => m.text === 'A letter about the garden.'));
  await page.reload();
  await page.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).click();
  await page.locator('.excalidraw canvas').first().waitFor();
  await page.getByRole('button', { name: 'Inspect Writer', exact: true }).click();
  await log().getByText('A letter about the garden.', { exact: true }).waitFor();
  f.resume(); await panel.getByText('Who will read it?', { exact: true }).waitFor();
  assert.equal((await f.agent()).interview.messages.filter(m => m.role === 'user').length, 1); check('reload mid-interview keeps the answer once');
  f.answer('{"task":"Write a garden letter for my sister."}');
  await input().fill('My sister.'); await input().press('Enter');
  await panel.getByLabel('Proposed task').waitFor();
  assert.deepEqual(await log().locator('.chat-end .chat-bubble').allTextContents(), ['A letter about the garden.', 'My sister.']);
  assert.doesNotMatch(await log().innerText(), /Continue the interview|Conversation:|[{}]/);
  assert.equal((await f.agent()).task, ''); check('several answers stay in order; proposed task waits for Start');
  for (const theme of ['Light', 'Dark']) {
    await page.locator('.account-row').click();
    await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await page.getByRole('radio', { name: theme, exact: true }).click();
    await page.getByRole('button', { name: 'Back to app', exact: true }).click();
    await page.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect Writer', exact: true }).click();
    await panel.getByLabel('Proposed task').waitFor();
    assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    assert.ok(await panel.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1));
    await fs.writeFile(path.join(evidence, `geometry-${theme.toLowerCase()}.json`), JSON.stringify(await panel.evaluate(el => ({ viewport: innerWidth, dpr: devicePixelRatio, page: document.documentElement.getBoundingClientRect().toJSON(), panel: el.getBoundingClientRect().toJSON(), parent: el.parentElement.getBoundingClientRect().toJSON(), root: document.querySelector('.love-spot').getBoundingClientRect().toJSON() })), null, 2));
    await capture(`interview-${theme.toLowerCase()}.png`);
  }
  check('light and dark interview screens fit their panel');
  f.answer('{"question":');
  await input().fill('Keep it short.'); await input().press('Enter');
  await panel.getByRole('alert').getByText(/invalid interview reply/).waitFor();
  assert.doesNotMatch(await panel.getByRole('alert').innerText(), /[{}]/);
  await capture('malformed.png'); check('malformed reply gives a readable error and retains the answer');
  f.fail('{"error":{"message":"private wire details"}}');
  await panel.getByRole('button', { name: 'Retry question', exact: true }).click();
  await panel.getByRole('alert').getByText(/could not ask/).waitFor();
  assert.doesNotMatch(await panel.getByRole('alert').innerText(), /[{}]|private wire details/);
  await capture('agent-error.png'); check('agent failure gives a readable error');
  f.answer('{"task":"Write a short garden letter for my sister."}');
  await panel.getByRole('button', { name: 'Retry question', exact: true }).click();
  await panel.getByLabel('Proposed task').waitFor();
  assert.equal((await f.agent()).interview.messages.filter(m => m.text === 'Keep it short.').length, 1);
  f.answer('Dear sister, the garden is blooming.');
  await panel.getByRole('button', { name: 'Start', exact: true }).click();
  await panel.getByRole('region', { name: 'Answer', exact: true }).getByText('Dear sister, the garden is blooming.', { exact: true }).waitFor();
  assert.equal((await f.client.listThreads()).data.length, 1);
  await panel.getByRole('button', { name: 'Open its chat', exact: true }).click();
  await page.getByText('Write a short garden letter for my sister.', { exact: true }).last().waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /Continue the interview|Conversation:|\{"question"/);
  await capture('confirmed-chat.png'); check('Start runs once; its chat shows the confirmed task and plain answer');
  await capture('chat-list.png'); check('chat list contains only the confirmed execution');
  f.answer('{"question":"Who will read the letter?"}');
  await runAcpNode(f.nodeSpec({ name: 'Writer history', model: 'gpt-6-luna', prompt: 'Writer' }), { task: `Continue the interview. Conversation:\n${JSON.stringify([{ role: 'assistant', text: 'What would you like to write?' }, { role: 'user', text: 'A garden letter.' }])}` }, { cwd: f.root, timeoutMs: 5000 });
  await page.getByText('Love Spot · Writer history', { exact: true }).first().click();
  await page.getByText('Who will read the letter?', { exact: true }).last().waitFor();
  await page.getByText('A garden letter.', { exact: true }).last().waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /Continue the interview|Conversation:|\{"question"/);
  await capture('saved-chat.png'); check('saved interview chat decodes its question and restores only the real conversation');
  await page.goto(new URL('love-spot.html', page.url()).href);
  await page.locator('.excalidraw canvas').first().waitFor();
  f.answer('{"question":"What should I review?"}');
  await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Add Critic', exact: true }).click();
  await panel.getByText('What should I review?', { exact: true }).waitFor();
  f.answer('{"task":"Review the garden letter."}');
  await panel.getByRole('textbox', { name: 'Reply to Critic', exact: true }).fill('The garden letter.');
  await panel.getByRole('textbox', { name: 'Reply to Critic', exact: true }).press('Enter');
  await panel.getByLabel('Proposed task').waitFor();
  const calls = f.requests.filter(r => r.method === 'turn/start').length;
  await app.close(); app = await launch(); page = await app.firstWindow(); page.setDefaultTimeout(15000);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1680, 1080));
  await page.locator('.nav-list').getByRole('button', { name: 'Love Spot', exact: true }).waitFor();
  await page.goto(new URL('love-spot.html', page.url()).href);
  await page.locator('.excalidraw canvas').first().waitFor();
  panel = page.getByLabel('Agent details', { exact: true });
  await page.getByRole('button', { name: 'Inspect Critic', exact: true }).click();
  await panel.getByText('What should I review?', { exact: true }).waitFor();
  await panel.getByLabel('Proposed task').getByText('Review the garden letter.', { exact: true }).waitFor();
  assert.equal(f.requests.filter(r => r.method === 'turn/start').length, calls);
  assert.doesNotMatch(await log().innerText(), /Continue the interview|Conversation:|[{}]/);
  await capture('standalone-restarted.png'); check('standalone interview survives app restart without a duplicate question or answer');
} catch (error) {
  if (page) { await capture('failure.png').catch(() => {}); await fs.writeFile(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await app?.close(); await f.close();
  await fs.writeFile(path.join(evidence, 'checks.json'), JSON.stringify(checks, null, 2));
}
