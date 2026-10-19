const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const agents = scene => scene.elements.filter(e => !e.isDeleted && e.customData?.loveAgent);
const output = path.join(process.env.HOME, '.cache/elpis-tests/love-agents-v2');
const agentEnv = node => ({ FAKE_ACP_ANSWER: node.prompt.includes('LOVE_INTERVIEW')
  ? JSON.stringify(node.prompt.includes('USER_ANSWER_SEED') ? { task: 'Research USER_ANSWER_SEED with primary sources.' } : { question: `What should I ${node.name === 'Critic' ? 'challenge' : 'investigate'} for you?` })
  : 'EXECUTION_SEED complete' });
async function open(f, surface) {
  if (surface === 'embedded') await f.open(f.page);
  else { await f.page.goto(new URL('love-spot.html', f.url).href); await f.page.locator('.excalidraw canvas').first().waitFor(); }
}
for (const surface of ['embedded', 'standalone']) test(`${surface}: A and one click create, interview, and undo one agent`, async () => {
  const f = await loveSpotFixture({ agentEnv });
  try {
    await open(f, surface); const { page } = f;
    const board = await page.locator('.love-spot-editor').boundingBox();
    await page.mouse.click(board.x + 400, board.y + 250);
    await page.keyboard.press('a');
    assert.equal(agents(await f.scene()).length, 0, 'A only arms placement');
    await page.keyboard.press('Escape');
    await page.mouse.click(board.x + 420, board.y + 260);
    assert.equal(agents(await f.scene()).length, 0, 'Escape cancels placement');
    await page.keyboard.press('a'); await page.mouse.click(board.x + 450, board.y + 300);
    const details = page.getByLabel('Agent details', { exact: true }); await details.waitFor();
    await page.getByRole('button', { name: 'Inspect Researcher', exact: true }).waitFor();
    await details.getByText('What should I investigate for you?', { exact: true }).waitFor();
    const saved = await f.waitFor(s => agents(s).length === 1 && agents(s)[0].customData.loveAgent.interview?.messages.length === 1, 'one question must persist');
    const card = agents(saved)[0], portrait = saved.elements.find(e => e.id === `${card.id}-portrait`);
    assert.equal(portrait.width, 96); assert.equal(portrait.height, 96);
    assert.ok(Math.abs(card.x + card.width / 2 - 450) < 3, 'card must be centred on the clicked scene point');
    assert.equal(card.customData.loveAgent.task, '', 'interview cannot start the task');
    const prompts = (await f.acp()).filter(e => e.method === 'session/prompt');
    assert.equal(prompts.length, 1, 'exactly one first question over ACP');
    assert.match(JSON.stringify(await f.acp()), /careful researcher/);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect Researcher', exact: true }).click();
    await page.waitForTimeout(200); assert.equal((await f.acp()).filter(e => e.method === 'session/prompt').length, 1);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.mouse.click(board.x + 100, board.y + 300); await page.keyboard.press('Control+z');
    await f.waitFor(s => agents(s).length === 0, 'undo must remove the card');
    assert.equal(await page.getByRole('button', { name: 'Inspect Researcher', exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
for (const colorScheme of ['light', 'dark']) test(`menu adds immediately, interviews, and waits for OK · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme, agentEnv });
  try {
    const { page } = f; await open(f, 'standalone'); await fs.mkdir(output, { recursive: true });
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    const picker = page.locator('.love-agent-picker'); await picker.waitFor();
    const portraits = picker.locator('img');
    assert.equal(await portraits.count(), 6);
    for (const portrait of await portraits.all()) assert.ok((await portrait.boundingBox()).width >= 48);
    await page.screenshot({ path: path.join(output, `menu-${colorScheme}.png`) });
    await page.setViewportSize({ width: 545, height: 640 });
    assert.deepEqual(await picker.locator('strong,small').evaluateAll(labels => labels.filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent)), [], 'menu names and descriptions must fit at the minimum width');
    await page.screenshot({ path: path.join(output, `menu-${colorScheme}-narrow.png`) });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.getByRole('menuitem', { name: 'Add Critic', exact: true }).click();
    const panel = page.getByLabel('Agent details', { exact: true }); await panel.waitFor();
    await panel.getByText('What should I challenge for you?', { exact: true }).waitFor();
    assert.equal(await page.locator('.love-agent-draft').count(), 0);
    const tab = page.getByRole('button', { name: 'Inspect Critic', exact: true }); assert.ok(await tab.locator('img').count());
    const input = panel.getByRole('textbox', { name: 'Reply to Critic', exact: true });
    await input.fill('USER_ANSWER_SEED'); await input.press('Enter');
    const start = panel.getByRole('button', { name: 'Start', exact: true }); await start.waitFor();
    await panel.getByText('Research USER_ANSWER_SEED with primary sources.', { exact: true }).waitFor();
    assert.equal((await f.acp()).filter(e => e.method === 'session/prompt').length, 2, 'proposal must wait for OK');
    assert.equal(agents(await f.scene())[0].customData.loveAgent.task, '', 'unaccepted proposal is not executable');
    await page.screenshot({ path: path.join(output, `interview-${colorScheme}.png`) });
    await page.setViewportSize({ width: 545, height: 640 });
    assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'narrow panel must fit');
    await page.screenshot({ path: path.join(output, `interview-${colorScheme}-narrow.png`) });
    await page.setViewportSize({ width: 1440, height: 960 });
    if (colorScheme === 'light') await input.press('Enter'); else await start.click();
    try { await f.waitFor(s => agents(s)[0]?.customData.loveAgent.output === 'EXECUTION_SEED complete', 'Enter on proposal must execute'); }
    catch (error) { await fs.writeFile(path.join(output, `failure-${colorScheme}.json`), JSON.stringify({ scene: await f.scene(), acp: await f.acp(), text: await panel.innerText() }, null, 2)); throw error; }
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.screenshot({ path: path.join(output, `card-${colorScheme}.png`) });
    await page.reload(); await page.locator('.excalidraw canvas').first().waitFor();
    await tab.click(); await panel.getByText('What should I challenge for you?', { exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('voice fills the interview reply; it waits for Send and typing A never places an agent', async () => {
  const f = await loveSpotFixture({ agentEnv });
  try {
    const { page } = f;
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
      window.MediaRecorder = class {
        static isTypeSupported() { return true; }
        state = 'inactive'; start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['test sound']) }); this.onstop?.(); }
      };
    });
    await page.route('**/api/tools/transcription?*', route => route.fulfill({ json: route.request().method() === 'POST' ? { text: 'USER_ANSWER_SEED' } : { available: true, backend: 'fixture', label: 'test transcriber' } }));
    await page.reload(); await open(f, 'standalone');
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add Researcher', exact: true }).click();
    const panel = page.getByLabel('Agent details', { exact: true });
    await panel.getByText('What should I investigate for you?', { exact: true }).waitFor();
    await panel.getByRole('button', { name: 'Dictate message', exact: true }).click();
    await panel.getByRole('button', { name: 'Stop recording and transcribe' }).click();
    const reply = panel.getByRole('textbox', { name: 'Reply to Researcher', exact: true });
    await reply.filter({ visible: true }).waitFor();
    await page.waitForFunction(() => document.getElementById('love-agent-reply')?.value === 'USER_ANSWER_SEED');
    assert.equal((await f.acp()).filter(e => e.method === 'session/prompt').length, 1, 'voice does not send by itself');
    await reply.press('a');
    assert.equal(await page.locator('[data-placing-agent=true]').count(), 0);
    await reply.fill('USER_ANSWER_SEED'); await panel.getByRole('button', { name: 'Send reply', exact: true }).click();
    await panel.getByRole('button', { name: 'Start', exact: true }).waitFor();
    assert.equal(agents(await f.scene()).length, 1);
    assert.equal((await f.acp()).filter(e => e.method === 'session/prompt').length, 2);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('existing preset cards receive the larger current art without changing their task or neighbouring drawing', async () => {
  const f = await loveSpotFixture({ agentEnv });
  try {
    const { page } = f; await open(f, 'standalone');
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add Researcher', exact: true }).click();
    await page.getByText('What should I investigate for you?', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await f.draw(page);
    const scene = await f.waitFor(s => s.elements.filter(e => e.type === 'rectangle' && !e.isDeleted).length === 2, 'neighbour drawing must persist');
    const card = agents(scene)[0], portrait = scene.elements.find(e => e.id === `${card.id}-portrait`);
    const drawing = scene.elements.find(e => e.type === 'rectangle' && !e.customData?.loveAgent && !e.isDeleted);
    card.customData.loveAgent.task = 'LEGACY_TASK_SEED';
    const oldId = 'love-portrait-researcher', currentId = portrait.fileId;
    portrait.fileId = oldId; portrait.x += 12; portrait.width = 72; portrait.height = 72;
    scene.files[oldId] = { ...scene.files[currentId], id: oldId, dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=' };
    delete scene.files[currentId];
    await page.goto('about:blank');
    await fs.writeFile(path.join(f.directory, 'scene.excalidraw'), JSON.stringify(scene));
    await open(f, 'standalone');
    await page.getByRole('button', { name: 'Inspect Researcher', exact: true }).click();
    const upgraded = await f.waitFor(s => s.elements.find(e => e.id === portrait.id)?.width === 96, 'legacy portrait must be enlarged');
    const image = upgraded.elements.find(e => e.id === portrait.id);
    assert.equal(image.height, 96); assert.notEqual(image.fileId, oldId);
    assert.ok(upgraded.files[image.fileId].dataURL.length > 10000, 'the current artwork replaces the planted legacy image');
    assert.equal(agents(upgraded)[0].customData.loveAgent.task, 'LEGACY_TASK_SEED');
    assert.deepEqual(upgraded.elements.find(e => e.id === drawing.id), drawing);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
