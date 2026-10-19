const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const agents = scene => scene.elements.filter(e => !e.isDeleted && e.customData?.loveAgent);

for (const dismissal of ['Escape', 'outside drag']) test(`${dismissal} closes the agent menu without drawing`, async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f; await f.open(page);
    const board = await page.locator('.excalidraw').boundingBox();
    await page.mouse.click(board.x + 800, board.y + 600);
    await page.keyboard.press('r');
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    const picker = page.getByRole('menu', { name: 'Agents', exact: true });
    await picker.waitFor();
    if (dismissal === 'Escape') await page.keyboard.press('Escape');
    else {
      await page.mouse.move(board.x + 600, board.y + 400);
      await page.mouse.down(); await page.mouse.move(board.x + 700, board.y + 500, { steps: 8 }); await page.mouse.up();
    }
    await picker.waitFor({ state: 'detached', timeout: 1500 });
    await page.waitForTimeout(400);
    assert.equal((await f.scene()).elements.length, 0);
    await f.draw(page);
    await f.waitFor(s => s.elements.some(e => e.type === 'rectangle' && !e.isDeleted), 'the board must still draw after dismissal');
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`Talk, agents and private screenshots work together without overlap · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme, replyDelay: 300 });
  try {
    const { page } = f;
    await f.open(page);
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add Researcher', exact: true }).click();
    const details = page.getByLabel('Agent details', { exact: true });
    await page.getByText('What should I help you with?', { exact: true }).waitFor();
    await details.locator('summary').click();
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Review our shared idea');
    await page.getByRole('button', { name: 'Talk', exact: true }).click();
    const talk = page.getByRole('region', { name: 'Love Spot Talk', exact: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=', 'base64');
    await fs.writeFile(path.join(f.screenshots, 'private-port.png'), png);
    const tray = page.getByRole('region', { name: 'New screenshots', exact: true });
    await tray.getByRole('button', { name: 'Add private-port.png to drawing', exact: true }).waitFor();
    await talk.getByRole('textbox', { name: 'Message Elpis' }).fill('Think with me here');
    await talk.getByRole('button', { name: 'Send', exact: true }).click();
    await details.getByRole('button', { name: 'Run connected agents', exact: true }).click();
    await talk.getByText('I am here with you.', { exact: true }).waitFor();
    const scene = await f.waitFor(s => agents(s)[0]?.customData.loveAgent.status === 'completed' && s.elements.some(e => e.text === 'I am here with you.' && e.strokeColor === '#1971c2'), 'Talk reply or agent result was lost');
    // The agent ran as its own ACP agent process; only Talk is an Elpis chat of this connection.
    assert.deepEqual(f.chats.map(chat => chat.name), ['Love Spot']);
    assert.equal(scene.elements.filter(e => e.id.startsWith('shot-')).length, 0, 'private screenshots must stay outside both conversation paths');
    assert.equal(scene.elements.filter(e => e.text === 'I am here with you.').length, 1, 'only Talk adds a reply note');
    assert.equal(agents(scene)[0].customData.loveAgent.output, 'Researcher(default) answered: Review our shared idea');
    assert.equal(f.turns.length, 1);
    assert.equal(f.turns.some(turn => JSON.stringify(turn).includes('private-port.png')), false);
    assert.equal(JSON.stringify(await f.acp()).includes('private-port.png'), false, 'private screenshots never reach an agent');
    await fs.mkdir('/tmp/agents-port-shots', { recursive: true });
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForTimeout(300);
      await details.evaluate(el => { el.scrollTop = 0; });
      const regions = [page.locator('.love-spot-tools'), tray, page.locator('.love-spot-editor'), details, talk];
      const boxes = await Promise.all(regions.map(region => region.boundingBox()));
      for (const [i, box] of boxes.entries()) {
        assert.ok(box && box.width > 0 && box.height > 0 && box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 961, `region ${i} must fit`);
        for (const other of boxes.slice(i + 1)) assert.ok(box.x + box.width <= other.x + 1 || other.x + other.width <= box.x + 1 || box.y + box.height <= other.y + 1 || other.y + other.height <= box.y + 1, `region ${i} must not overlap another feature`);
      }
      await page.screenshot({ path: `/tmp/agents-port-shots/${colorScheme}-${width}.png` });
    }
    // The private choice remains usable while both conversations exist.
    await tray.getByRole('button', { name: 'Add private-port.png to drawing', exact: true }).click();
    await f.waitFor(s => s.elements.some(e => e.id.startsWith('shot-')), 'explicit screenshot placement failed');
    await tray.waitFor({ state: 'detached' });
    await details.getByRole('button', { name: 'Done', exact: true }).click();
    await talk.getByRole('textbox', { name: 'Message Elpis' }).fill('Continue our chat');
    await talk.getByRole('button', { name: 'Send', exact: true }).click();
    await f.waitFor(s => s.elements.filter(e => e.text === 'I am here with you.' && e.strokeColor === '#1971c2').length === 2, 'Talk did not reuse its chat after an agent run');
    assert.equal(f.chats.length, 1);
    assert.deepEqual(f.errors, []);
  } catch (error) {
    await f.page.screenshot({ path: `/tmp/agents-port-failure-${colorScheme}.png` });
    await fs.writeFile(`/tmp/agents-port-failure-${colorScheme}.json`, JSON.stringify(await f.scene(), null, 2));
    throw error;
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`characters, native arrows, ACP handoff and inspection · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    const { page } = f;
    await f.open(page);
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('menu', { name: 'Agents', exact: true }).waitFor();
    for (const name of ['Researcher','Reviewer','Builder','Tester','Writer','Critic']) assert.equal(await page.getByRole('menuitem', { name: `Add ${name}`, exact: true }).count(), 1);
    const portraits = await page.getByRole('menu', { name: 'Agents', exact: true }).locator('img').evaluateAll(images => images.map(image => image.src));
    assert.equal(new Set(portraits).size, 6, 'all characters have different generated portraits');
    assert.ok(portraits.every(src => src.startsWith('data:image/svg+xml')), 'portraits contain traced multicolour vectors');
    await page.getByRole('menuitem', { name: 'Add Researcher', exact: true }).click();
    await page.getByText('What should I help you with?', { exact: true }).waitFor();
    await page.getByLabel('Agent details').locator('summary').click();
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Trace this unique board seed');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    // Move the first card left; menu placement is intentionally at the viewport centre.
    const first = agents(await f.waitFor(s => agents(s).length === 1, 'first card persists'))[0];
    const board = await page.locator('.excalidraw').boundingBox();
    await page.keyboard.press('Escape'); await page.keyboard.press('v');
    await page.mouse.move(board.x + board.width / 2, board.y + board.height / 2);
    await page.mouse.down(); await page.mouse.move(board.x + board.width / 2 - 300, board.y + board.height / 2, { steps: 12 }); await page.mouse.up();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add Reviewer', exact: true }).click();
    await page.getByLabel('Agent details').getByText('What should I help you with?', { exact: true }).waitFor();
    await page.getByLabel('Agent details').locator('summary').click();
    assert.match(await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), /review/i);
    assert.equal(await page.getByRole('textbox', { name: 'Model', exact: true }).inputValue(), 'gpt-6-luna');
    assert.equal(await page.getByRole('textbox', { name: 'Provider', exact: true }).inputValue(), 'openai');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const cards = agents(await f.waitFor(s => agents(s).length === 2, 'two cards must persist'));
    // The arrow tool's number shortcut remains available; A now belongs to agent placement.
    await page.mouse.click(board.x + 850, board.y + 550); await page.keyboard.press('Escape'); await page.keyboard.press('5');
    const moved = cards.find(c => c.id === first.id), second = cards.find(c => c.id !== first.id);
    await page.mouse.move(board.x + moved.x + moved.width, board.y + moved.y + 95);
    await page.mouse.down(); await page.mouse.move(board.x + second.x, board.y + second.y + 95, { steps: 14 }); await page.mouse.up();
    await page.keyboard.press('Escape');
    await f.waitFor(s => s.elements.some(e => e.type === 'arrow' && e.startBinding?.elementId === first.id && e.endBinding?.elementId === second.id), 'mouse-drawn arrow must bind the two character cards');
    // A real click on the card opens the same inspector as the keyboard list.
    await page.mouse.click(board.x + moved.x + 110, board.y + moved.y + 95);
    await page.getByRole('button', { name: 'Run connected agents', exact: true }).click();
    await f.waitFor(s => agents(s).every(e => e.customData.loveAgent.status === 'completed'), 'both agents should finish');
    const prompts = (await f.acp()).filter(message => message.method === 'session/prompt' && !message.params.prompt[0].text.startsWith('Continue the interview.')).map(message => message.params.prompt[0].text);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Researcher\(default\) answered: Trace this unique board seed/, 'the first answer reaches the second agent over ACP');
    await page.getByRole('button', { name: 'Inspect Reviewer', exact: true }).click();
    assert.equal(await page.getByLabel('Agent details', { exact: true }).locator('.love-agent-heading strong').innerText(), 'Reviewer');
    await page.getByRole('region', { name: 'Answer', exact: true }).waitFor();
    assert.match(await page.getByRole('region', { name: 'Answer', exact: true }).innerText(), /Reviewer\(default\) answered:/);
    await fs.mkdir('/tmp/love-agents-shots', { recursive: true });
    await page.screenshot({ path: `/tmp/love-agents-shots/${colorScheme}.png` });
    await page.reload(); await f.open(page);
    await page.getByRole('button', { name: 'Inspect Reviewer', exact: true }).click();
    assert.match(await page.getByRole('region', { name: 'Answer', exact: true }).innerText(), /unique board seed/);
    assert.deepEqual(f.errors, []);
  } catch (error) {
    await f.page.screenshot({ path: `/tmp/love-agents-failure-${colorScheme}.png` });
    await fs.writeFile(`/tmp/love-agents-failure-${colorScheme}.json`, JSON.stringify(await f.scene(), null, 2));
    throw error;
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`an agent's permission request is answered from its panel · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    const { page } = f;
    await f.open(page);
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add Researcher', exact: true }).click();
    await page.getByText('What should I help you with?', { exact: true }).waitFor();
    await page.getByLabel('Agent details').locator('summary').click();
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('[permission] Save the plan');
    const details = page.getByLabel('Agent details', { exact: true });
    await details.getByRole('button', { name: 'Run connected agents', exact: true }).click();
    const request = details.getByRole('group', { name: 'Permission request', exact: true });
    await request.getByText('Write notes.txt', { exact: true }).waitFor();
    await details.getByText('Waiting for your answer', { exact: true }).waitFor();
    await fs.mkdir('/tmp/love-agents-shots', { recursive: true });
    await page.screenshot({ path: `/tmp/love-agents-shots/permission-${colorScheme}.png` });
    await request.getByRole('button', { name: 'Allow once', exact: true }).click();
    const scene = await f.waitFor(s => agents(s)[0]?.customData.loveAgent.status === 'completed', 'the agent should finish once answered');
    assert.match(agents(scene)[0].customData.loveAgent.output, /permission: allow_once\. \[permission\] Save the plan/);
    assert.deepEqual((await f.acp()).find(message => message.permission).permission, { outcome: 'selected', optionId: 'allow_once' });
    await request.waitFor({ state: 'detached' });
    assert.deepEqual(f.errors, []);
  } catch (error) {
    await f.page.screenshot({ path: `/tmp/love-agents-failure-permission-${colorScheme}.png` });
    throw error;
  } finally { await f.close(); }
});

test('@agent in a note creates a character once; ordinary notes stay notes', async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f; await f.open(page);
    const board = await page.locator('.excalidraw').boundingBox();
    await page.mouse.click(board.x + 800, board.y + 600);
    await page.keyboard.press('t'); await page.mouse.click(board.x + 240, board.y + 320);
    await page.locator('textarea.excalidraw-wysiwyg').waitFor();
    await page.keyboard.type('@agent Writer Explain this small idea'); await page.keyboard.press('Escape');
    await f.waitFor(s => agents(s).length === 1, 'keyword should create one character');
    await page.getByRole('button', { name: 'Inspect Writer', exact: true }).click();
    await page.getByLabel('Agent details').locator('summary').click();
    assert.equal(await page.getByRole('textbox', { name: 'Task', exact: true }).inputValue(), 'Explain this small idea');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.mouse.click(board.x + 800, board.y + 600);
    await page.keyboard.press('Escape'); await page.keyboard.press('t'); await page.mouse.click(board.x + 550, board.y + 500);
    await page.keyboard.type('Ordinary note'); await page.keyboard.press('Escape');
    await f.waitFor(s => s.elements.some(e => !e.isDeleted && e.type === 'text' && e.text === 'Ordinary note'), 'ordinary note persists');
    assert.equal(agents(await f.scene()).length, 1);
    assert.deepEqual(f.errors, []);
  } catch (error) {
    await f.page.screenshot({ path: '/tmp/love-agents-failure-keyword.png' });
    await fs.writeFile('/tmp/love-agents-failure-keyword.json', JSON.stringify(await f.scene(), null, 2));
    throw error;
  } finally { await f.close(); }
});
