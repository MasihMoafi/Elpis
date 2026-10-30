// Edit an earlier message, fork from a reply and rewind, through the real chain: this renderer (out/), this bridge,
// this provider bridge (tools/elpis-claude/acp-bridge.mjs) and the installed engine. Inference is local: the
// Responses fixture for the native model, the fake ACP agent for claude/sonnet. Nothing leaves the machine.
// Run: ELPIS_ENGINE_BIN=$(readlink -f ~/.local/bin/elpis-next) node --test tests/edit-fork-real.test.cjs
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Provider, message } = require('../../../scripts/lib/mock-provider.js');
const { fakeDesktop } = require('./fake-desktop.cjs');

const engine = process.env.ELPIS_ENGINE_BIN;
const skip = !engine && 'set ELPIS_ENGINE_BIN to an Elpis engine executable';
const repo = path.resolve(__dirname, '../../..');
const NOTE = { id: 'note1', name: 'note.txt', type: 'text', mimeType: 'text/plain', text: 'Attached note body 4417' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, ms = 30000) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(100)) if (await check()) return;
  throw new Error(`Timed out: ${label}`);
}
let h;

before(async () => {
  if (skip) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-fork-'));
  const home = path.join(root, 'home'), project = path.join(root, 'project');
  await fs.mkdir(home); await fs.mkdir(project);
  const provider = new Provider(); await provider.start();
  // Every native request is answered with the next queued reply, or "reply N".
  const replies = []; let n = 0;
  provider.actions = { shift: () => message(replies.shift() ?? `reply ${++n}`) };
  const catalog = require(path.join(repo, 'codex-rs/models-manager/models.json'));
  await fs.writeFile(path.join(home, 'models.json'), JSON.stringify({ models: catalog.models.filter(model => model.slug === 'gpt-5.5') }));
  await fs.writeFile(path.join(home, 'config.toml'), `model="gpt-5.5"\nmodel_provider="fixture"\nmodel_catalog_json=${JSON.stringify(path.join(home, 'models.json'))}\napproval_policy="never"\nsandbox_mode="workspace-write"\n[features]\ncode_mode=false\n[model_providers.fixture]\nname="Edit test"\nbase_url=${JSON.stringify(provider.url)}\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(project)}]\ntrust_level="trusted"\n`);
  const socketPath = path.join(root, 'b.sock'), acpLog = path.join(root, 'acp.jsonl'), agyLog = path.join(root, 'agy.jsonl');
  const agy = path.join(root, 'fake-agy');
  await fs.copyFile(path.join(repo, 'tools/elpis-claude/test/fake-agy.cjs'), agy); await fs.chmod(agy, 0o755);
  const log = await fs.open(path.join(root, 'bridge.log'), 'a');
  const env = { PATH: process.env.PATH, HOME: root, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home, CODEX_SQLITE_HOME: home,
    XDG_CONFIG_HOME: path.join(root, '.config'), XDG_RUNTIME_DIR: root, TMPDIR: root, LANG: 'C.UTF-8', ELPIS_SHARED_BRIDGE: '1', ELPIS_BRIDGE_SOCKET: socketPath,
    ELPIS_ENGINE_BIN: engine, ACP_ADAPTER: path.join(repo, 'tools/elpis-claude/test/fake-acp-agent.mjs'),
    ACP_BRIDGE_STORE: path.join(root, 'sessions.json'), ACP_BRIDGE_LOG: path.join(root, 'adapter.log'), ACP_BRIDGE_NO_AGENTS: '1',
    FAKE_ACP_LOG: acpLog, FAKE_ACP_NAME: 'Claude', FAKE_ACP_MODELS: 'sonnet', AGY_BIN: agy, FAKE_AGY_LOG: agyLog, FAKE_AGY_RELEASE: path.join(root, 'agy-release') };
  const bridge = spawn(process.execPath, [path.join(repo, 'tools/elpis-claude/acp-bridge.mjs')], { env, cwd: project, detached: true, stdio: ['ignore', log.fd, log.fd] });
  await until(async () => { if (bridge.exitCode !== null) throw new Error(`provider bridge exited; see ${root}/bridge.log`); return fs.stat(socketPath).then(() => true, () => false); }, 'provider bridge socket');
  const { DesktopClient } = await import('../bridge/client.mjs');
  const { startDesktopServer } = await import('../bridge/server.mjs');
  const client = await DesktopClient.connect({ socketPath, appHome: root, home });
  await client.models();
  const app = await startDesktopServer({ client, elpisHome: home, trashFile: path.join(home, 'trash.json'), loveSpot: { directory: path.join(root, 'drawing') } });
  const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.setDefaultTimeout(20000);
  await page.addInitScript(fakeDesktop);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const completed = new Set(); client.on('event', event => { if (event.type === 'message' && event.data?.method === 'turn/completed') completed.add(event.data.params.turn?.id ?? event.data.params.turnId); });
  const prompts = async () => (await fs.readFile(acpLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse).filter(row => row.method === 'session/prompt').map(row => JSON.stringify(row.params.prompt));
  const agyPrompts = async () => (await fs.readFile(agyLog, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(JSON.parse).map(row => row.text);
  h = { root, project, provider, replies, bridge, log, client, app, browser, page, errors, completed, prompts, agyPrompts };
  /** Setup only: a chat with these turns, sent through the bridge as the composer would send them. */
  h.chat = async (model, turns) => {
    const { thread } = await client.createThread({ cwd: project, model, permissions: 'full' });
    for (const [text, reply, attachments] of turns) {
      if (reply) replies.push(reply);
      const { turn } = await client.send(thread.id, { text, ...(attachments ? { attachments } : {}) });
      await until(() => completed.has(turn.id), `turn "${text}" completed`);
    }
    return thread.id;
  };
  h.open = async id => {
    await page.goto(app.url); await page.locator('.startup-splash').waitFor({ state: 'detached' }).catch(() => {});
    await page.locator(`.thread-row[data-thread-id="${id}"] .thread-link`).first().click();
    await page.locator('.chat-content .user-turn').first().waitFor();
  };
  h.transcript = () => page.locator('.chat-content').innerText();
  h.turn = text => page.locator('.user-turn').filter({ has: page.locator('.message.user', { hasText: text }) });
  /** On failure: what the page shows and says, kept under the run's folder. */
  h.diagnose = async (name, run) => {
    try { await run(); } catch (error) {
      await page.screenshot({ path: path.join(root, `${name}.png`) }).catch(() => {});
      const banners = await page.locator('.error-banner, [role=alert]').allInnerTexts().catch(() => []);
      const note = `\nbanners: ${JSON.stringify(banners)}\nevidence: ${root}`; error.message += note; error.stack = `${error.stack}${note}`;
      throw error;
    }
  };
  h.items = async id => (await client.readThread(id, {})).data.map(entry => [entry.turnId, entry.item.type, entry.item.id, entry.item.text ?? JSON.stringify(entry.item.content ?? null)]);
});

after(async () => {
  if (!h) return;
  await h.browser?.close(); await h.app?.close(); h.client?.close();
  if (h.bridge.exitCode === null) { const ended = once(h.bridge, 'exit'); h.bridge.kill('SIGTERM'); await Promise.race([ended, pause(5000)]); }
  try { process.kill(-h.bridge.pid, 'SIGKILL'); } catch { /* already gone */ }
  await h.log.close(); h.provider.close();
});

for (const [provider, model] of [['Claude', 'claude/sonnet'], ['Antigravity', 'agy/gemini-3.8-flash-medium']]) test(`a stopped ${provider} turn with two follow-ups can be rewound and edited`, { skip, timeout: 60000 }, async () => {
  const { page, client, project } = h;
  const prompts = provider === 'Claude' ? h.prompts : h.agyPrompts;
  const { thread } = await client.createThread({ cwd: project, model, permissions: 'full' });
  const { turn } = await client.send(thread.id, { text: '[wait] original long turn' });
  await until(async () => (await prompts()).some(prompt => prompt.includes('original long turn')), 'the long turn starts');
  await h.open(thread.id);
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  for (const text of ['first follow-up', 'second follow-up']) {
    await composer.fill(text); await composer.press('Enter');
    await h.turn(text).waitFor();
  }
  await until(async () => (await h.items(thread.id)).filter(row => row[1] === 'userMessage').length === 3, 'both follow-ups are recorded');
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await until(() => h.completed.has(turn.id), 'the turn stops');
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  const first = h.turn('original long turn');
  await first.locator('.message.user').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rewind to here', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByLabel('Restore', { exact: true }).waitFor();
  await dialog.getByLabel('Restore', { exact: true }).press('Enter');
  await page.getByRole('option', { name: 'Conversation only', exact: true }).click();
  await dialog.getByRole('button', { name: 'Rewind', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await h.turn('first follow-up').waitFor({ state: 'hidden' });
  await h.turn('second follow-up').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Undo rewind', exact: true }).click();
  await h.turn('second follow-up').waitFor();
  await first.getByRole('button', { name: 'Edit message', exact: true }).click();
  const edit = page.getByRole('textbox', { name: 'Edited message', exact: true });
  assert.equal(await edit.inputValue(), '[wait] original long turn');
  if (process.env.ELPIS_APP_SHOTS) {
    await fs.mkdir(process.env.ELPIS_APP_SHOTS, { recursive: true });
    for (const scheme of ['light', 'dark']) {
      if (scheme === 'dark') {
        await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
        await page.getByRole('button', { name: 'Use light theme', exact: true }).waitFor();
        await page.waitForFunction(() => {
          const element = document.querySelector('[aria-label="Edited message"]');
          return element && (getComputedStyle(element).color.match(/\d+/g) ?? []).slice(0, 3).every(value => Number(value) >= 160);
        });
        await page.waitForTimeout(350);
      }
      await page.screenshot({ path: path.join(process.env.ELPIS_APP_SHOTS, `${provider.toLowerCase()}-rewind-${scheme}.png`) });
    }
  }
  await edit.fill('replacement after stop');
  await page.getByRole('form', { name: 'Edit message', exact: true }).getByRole('button', { name: 'Send', exact: true }).click();
  await until(async () => (await prompts()).some(prompt => prompt.includes('replacement after stop')), 'the replacement reaches the provider');
  await page.locator('.message.agent', { hasText: 'replacement after stop' }).waitFor();
  await h.turn('replacement after stop').waitFor();
  await h.turn('first follow-up').waitFor({ state: 'hidden', timeout: 5000 });
  await h.turn('second follow-up').waitFor({ state: 'hidden', timeout: 5000 });
  const shown = await h.transcript();
  assert.ok(!shown.includes('first follow-up') && !shown.includes('second follow-up'));
  assert.deepEqual(h.errors, []);
});

test('Antigravity answers in-flight messages and never replays stopped follow-ups', { skip, timeout: 60000 }, async () => {
  const { page, client, project } = h;
  const begin = async (original, followups) => {
    const { thread } = await client.createThread({ cwd: project, model: 'agy/gemini-3.8-flash-medium', permissions: 'full' });
    const { turn } = await client.send(thread.id, { text: original });
    await until(async () => (await h.agyPrompts()).some(prompt => prompt.includes(original)), 'the provider starts');
    await h.open(thread.id);
    const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
    for (const text of followups) { await composer.fill(text); await composer.press('Enter'); await h.turn(text).waitFor(); }
    await until(async () => (await h.items(thread.id)).filter(row => row[1] === 'userMessage').length === 3, 'both follow-ups are recorded');
    return { thread, turn, composer };
  };
  const stopped = await begin('[wait] stopped original', ['stopped follow-up one', 'stopped follow-up two']);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await until(() => h.completed.has(stopped.turn.id), 'the first turn stops');
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  await stopped.composer.fill('new message after stop'); await stopped.composer.press('Enter');
  await page.locator('.message.agent', { hasText: 'new message after stop' }).waitFor();
  const sent = await h.agyPrompts();
  assert.ok(sent.some(prompt => prompt.includes('new message after stop')));
  assert.ok(!sent.some(prompt => /stopped follow-up (one|two)/.test(prompt)), 'stopped follow-ups are not sent later');
  const continued = await begin('[wait] continued original', ['answered follow-up one', 'answered follow-up two']);
  await fs.writeFile(path.join(h.root, 'agy-release'), '');
  await until(() => h.completed.has(continued.turn.id), 'the turn answers the follow-ups');
  for (const text of ['answered follow-up one', 'answered follow-up two']) await page.locator('.message.agent', { hasText: text }).waitFor();
  assert.deepEqual(h.errors, []);
});

test('editing an earlier message continues from the edit, keeps its attachment, and the earlier version stays reachable', { skip, timeout: 180000 }, () => h.diagnose('edit', async () => {
  const { page } = h;
  const id = await h.chat('gpt-5.5', [['first question', 'Answer one'], ['second question', 'Answer two', [NOTE]], ['third question', 'Answer three']]);
  await h.open(id); await page.getByText('Answer three', { exact: true }).waitFor();
  const second = h.turn('second question');
  await second.getByRole('button', { name: 'Edit message', exact: true }).click();
  const box = page.getByRole('textbox', { name: 'Edited message', exact: true });
  assert.equal(await box.inputValue(), 'second question', 'only the typed text is edited; the attachment stays with the message');
  await box.fill('second question EDITED');
  h.replies.push('Answer two edited');
  await page.getByRole('form', { name: 'Edit message', exact: true }).getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Answer two edited', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  const shown = await h.transcript();
  for (const kept of ['first question', 'Answer one', 'second question EDITED', 'Answer two edited']) assert.ok(shown.includes(kept), `${kept} is shown`);
  for (const gone of ['Answer two\n', 'third question', 'Answer three']) assert.ok(!`${shown}\n`.includes(gone), `${gone.trim()} is replaced`);
  assert.ok(await h.turn('second question EDITED').getByText('note.txt').count(), 'the attachment is still on the edited message');
  const asked = JSON.stringify(h.provider.requests.at(-1).body.input);
  assert.match(asked, /second question EDITED/); assert.match(asked, /Attached note body 4417/); assert.match(asked, /Answer one/);
  assert.doesNotMatch(asked, /third question|Answer three|Answer two"/);
  // ChatGPT's ‹ 2/2 ›: the earlier version is one click away, and back.
  const edited = h.turn('second question EDITED');
  await edited.getByText('2 / 2', { exact: true }).waitFor();
  await edited.getByRole('button', { name: 'Previous version', exact: true }).click();
  await page.getByText('Answer three', { exact: true }).waitFor();
  const old = await h.transcript();
  for (const back of ['first question', 'Answer one', 'second question', 'Answer two', 'third question', 'Answer three']) assert.ok(old.includes(back), `${back} is back in the earlier version`);
  assert.ok(!old.includes('second question EDITED'));
  await h.turn('second question').getByText('1 / 2', { exact: true }).waitFor();
  await h.turn('second question').getByRole('button', { name: 'Next version', exact: true }).click();
  await page.getByText('Answer two edited', { exact: true }).waitFor();
  assert.ok(!(await h.transcript()).includes('third question'));
  assert.deepEqual(h.errors, []);
}));

test('fork from a reply in a Claude chat opens a new chat with the history through that reply', { skip, timeout: 180000 }, () => h.diagnose('fork', async () => {
  const { page } = h;
  const id = await h.chat('claude/sonnet', [['alpha'], ['beta'], ['gamma']]);
  const before = await h.items(id);
  await h.open(id); await page.getByText('Claude(sonnet) answered: gamma', { exact: true }).waitFor();
  const reply = page.locator('.message.agent', { hasText: 'Claude(sonnet) answered: alpha' });
  await reply.hover(); await reply.getByRole('button', { name: 'More message actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fork chat from here', exact: true }).click();
  const active = () => page.locator('.thread-row.active').getAttribute('data-thread-id', { timeout: 1000 }).catch(() => null);
  await until(async () => ![null, id].includes(await active()), 'the fork opens');
  await page.getByText('Claude(sonnet) answered: alpha', { exact: true }).waitFor();
  const forkId = await page.locator('.thread-row.active').getAttribute('data-thread-id');
  assert.equal(await page.locator('.error-banner').filter({ hasText: /fork/i }).count(), 0);
  const forked = await h.transcript();
  assert.ok(forked.includes('alpha')); assert.ok(!forked.includes('beta') && !forked.includes('gamma'), 'the fork stops at the chosen reply');
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  await composer.fill('delta'); await composer.press('Enter');
  // A fork starts a fresh Claude session, seeded with the history through the chosen reply (the fake agent echoes it).
  await until(async () => (await h.prompts()).at(-1)?.includes('delta'), 'Claude gets the follow-up in the fork');
  const seeded = (await h.prompts()).at(-1);
  assert.match(seeded, /alpha/); assert.doesNotMatch(seeded, /beta|gamma/);
  await page.locator('.message.agent', { hasText: /answered:[\s\S]*delta/ }).waitFor();
  assert.deepEqual(await h.items(id), before, 'the source chat is unchanged');
  assert.ok((await h.items(forkId)).some(row => row[3].includes('Claude(sonnet) answered: alpha')));
  assert.deepEqual(h.errors, []);
}));

test('editing a Claude message and rewinding change only that chat: its unedited messages and the other chat stay as they were', { skip, timeout: 180000 }, () => h.diagnose('negative', async () => {
  const { page } = h;
  const other = await h.chat('gpt-5.5', [['other chat question', 'Other chat answer']]);
  const id = await h.chat('claude/sonnet', [['alpha'], ['beta', null, [NOTE]], ['gamma']]);
  const otherBefore = await h.items(other), mine = await h.items(id);
  const alphaRows = rows => rows.filter(row => row[0] === mine.find(r => r[3].includes('"alpha"'))[0]);
  await h.open(id); await page.getByText('Claude(sonnet) answered: gamma', { exact: true }).waitFor();
  await h.turn('beta').getByRole('button', { name: 'Edit message', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edited message', exact: true }).fill('beta EDITED');
  await page.getByRole('form', { name: 'Edit message', exact: true }).getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText(/Claude\(sonnet\) answered: beta EDITED/).waitFor();
  await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
  assert.match((await h.prompts()).at(-1), /beta EDITED/); assert.match((await h.prompts()).at(-1), /Attached note body 4417/);
  assert.ok(!(await h.transcript()).includes('gamma'));
  assert.deepEqual(alphaRows(await h.items(id)), alphaRows(mine), 'the unedited first turn keeps its messages');
  // Rewind to the edited message: the chat goes back to before it, and its text returns to the message box.
  await h.turn('beta EDITED').locator('.message.user').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rewind to here', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: 'Rewind', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
  await page.getByText(/answered: beta EDITED/).waitFor({ state: 'hidden' });
  assert.ok((await h.transcript()).includes('Claude(sonnet) answered: alpha'));
  assert.equal(await page.getByRole('textbox', { name: 'Message Elpis', exact: true }).inputValue(), 'beta EDITED');
  await page.getByRole('button', { name: 'Undo rewind', exact: true }).click();
  await page.getByText(/answered: beta EDITED/).waitFor();
  assert.deepEqual(await h.items(other), otherBefore, 'the other chat is unchanged');
  await page.locator(`.thread-row[data-thread-id="${other}"] .thread-link`).first().click();
  await page.getByText('Other chat answer', { exact: true }).waitFor();
  assert.ok(!(await h.transcript()).includes('beta'));
  assert.deepEqual(h.errors, []);
}));
