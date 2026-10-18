const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const agents = scene => scene.elements.filter(e => !e.isDeleted && e.customData?.loveAgent);

for (const colorScheme of ['light', 'dark']) test(`Talk, agents and private screenshots work together without overlap · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme, replyDelay: 300 });
  try {
    const { page } = f;
    await f.open(page);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const details = page.getByLabel('Agent details', { exact: true });
    await details.getByRole('textbox', { name: 'Task', exact: true }).fill('Review our shared idea');
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
    assert.equal(f.chats.length, 2);
    assert.equal(new Set(f.chats.map(chat => chat.id)).size, 2);
    assert.deepEqual(f.chats.map(chat => chat.name).sort(), ['Love Spot', 'Love Spot · Researcher']);
    assert.equal(scene.elements.filter(e => e.id.startsWith('shot-')).length, 0, 'private screenshots must stay outside both conversation paths');
    assert.equal(scene.elements.filter(e => e.text === 'I am here with you.').length, 1, 'only Talk adds a reply note');
    assert.equal(agents(scene)[0].customData.loveAgent.output, 'I am here with you.');
    assert.equal(f.turns.length, 2);
    assert.equal(f.turns.some(turn => JSON.stringify(turn).includes('private-port.png')), false);
    await fs.mkdir('/tmp/agents-port-shots', { recursive: true });
    for (const width of [1280, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForTimeout(300);
      await details.evaluate(el => { el.scrollTop = 0; });
      const regions = [page.locator('.love-spot-tools'), tray, page.locator('.love-agent-list'), page.locator('.love-spot-editor'), details, talk];
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
    assert.equal(f.chats.length, 2);
    assert.deepEqual(f.errors, []);
  } catch (error) {
    await f.page.screenshot({ path: `/tmp/agents-port-failure-${colorScheme}.png` });
    await fs.writeFile(`/tmp/agents-port-failure-${colorScheme}.json`, JSON.stringify(await f.scene(), null, 2));
    throw error;
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`characters, native arrows, real chat handoff and inspection · ${colorScheme}`, async () => {
  const calls = [];
  const f = await loveSpotFixture({ colorScheme, configureClient(client) {
    client.createThread = async body => { calls.push(body); return { thread: { id: `chat-${calls.length}` } }; };
    client.send = async (id, body) => {
      calls.push({ id, ...body });
      client.emit('event', { type: 'message', data: { method: 'turn/completed', params: { threadId: id, turn: { id: 'turn', status: 'completed', items: [{ type: 'agentMessage', phase: 'final_answer', text: `Unique reply ${id}: ${body.text}` }] } } } });
      return { turn: { id: 'turn' } };
    };
  } });
  try {
    const { page } = f;
    await f.open(page);
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    for (const name of ['Researcher','Reviewer','Builder','Tester','Writer','Critic']) assert.equal(await page.getByRole('button', { name: `Add ${name}`, exact: true }).count(), 1);
    const portraits = await page.getByLabel('Choose an agent', { exact: true }).locator('img').evaluateAll(images => images.map(image => image.src));
    assert.equal(new Set(portraits).size, 6, 'all characters have different generated portraits');
    // The characters Masih accepted (18 Oct), made by image generation and traced, not the old drawn faces.
    assert.ok(portraits.every(src => src.startsWith('data:image/png;base64,')), 'the portraits are the new character art');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: 'Run connected agents', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Give Researcher a task' }).waitFor();
    assert.equal(calls.length, 0, 'invalid graph must not start chats');
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Trace this unique board seed');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.getByRole('button', { name: 'Characters', exact: true }).click();
    await page.getByRole('button', { name: 'Add Reviewer', exact: true }).click();
    assert.match(await page.getByRole('textbox', { name: 'Prompt', exact: true }).inputValue(), /review/i);
    assert.equal(await page.getByRole('textbox', { name: 'Model', exact: true }).inputValue(), 'gpt-6-luna');
    assert.equal(await page.getByRole('textbox', { name: 'Provider', exact: true }).inputValue(), 'openai');
    assert.match(await page.getByLabel('Agent details').innerText(), /Tools/);
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await f.waitFor(s => agents(s).length === 2, 'two cards must persist');
    assert.match(await page.locator('.love-spot [role="alert"]').innerText(), /Give Researcher a task/, 'drawing sync must not erase a run failure');
    const cards = agents(await f.scene());
    const board = await page.locator('.excalidraw').boundingBox();
    // Placement uses viewport coordinates and keeps cards side by side in the current view.
    await page.mouse.click(board.x + 850, board.y + 550);
    await page.keyboard.press('Escape'); await page.keyboard.press('a');
    await page.mouse.move(board.x + 470, board.y + 280);
    await page.mouse.down(); await page.mouse.move(board.x + 550, board.y + 280, { steps: 14 }); await page.mouse.up();
    await page.keyboard.press('Escape');
    await f.waitFor(s => s.elements.some(e => e.type === 'arrow' && e.startBinding?.elementId === cards[0].id && e.endBinding?.elementId === cards[1].id), 'mouse-drawn arrow must bind the two character cards');
    // A real click on the card opens the same inspector as the keyboard list.
    await page.mouse.click(board.x + 370, board.y + 280);
    await page.getByRole('button', { name: 'Run connected agents', exact: true }).click();
    await f.waitFor(s => agents(s).every(e => e.customData.loveAgent.status === 'completed'), 'both agents should finish');
    assert.match(calls[3].text, /Unique reply chat-1: Trace this unique board seed/);
    await page.getByRole('button', { name: 'Inspect Reviewer', exact: true }).click();
    assert.equal(await page.getByLabel('Agent details', { exact: true }).locator('.love-agent-heading strong').innerText(), 'Reviewer');
    await page.getByRole('region', { name: 'Answer', exact: true }).waitFor();
    assert.match(await page.getByRole('region', { name: 'Answer', exact: true }).innerText(), /Unique reply chat-3/);
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
