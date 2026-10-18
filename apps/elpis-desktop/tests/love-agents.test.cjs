const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const agents = scene => scene.elements.filter(e => !e.isDeleted && e.customData?.loveAgent);

for (const surface of ['embedded', 'standalone']) for (const confirmation of ['Enter', 'Add']) test(`${surface}: choosing an agent stays a focused draft until ${confirmation}`, async () => {
  const f = await loveSpotFixture();
  try {
    if (surface === 'embedded') await f.open(f.page);
    else { await f.page.goto(new URL('love-spot.html', f.url).href); await f.page.locator('.excalidraw canvas').first().waitFor(); }
    assert.equal(await f.page.getByRole('button', { name: /^(Agent|Characters)$/ }).count(), 0);
    await f.page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Add Critic', exact: true }).click();
    const task = f.page.getByRole('textbox', { name: 'Task', exact: true });
    assert.ok(await task.evaluate(el => el === document.activeElement), 'preset selection must focus its task');
    await task.fill('Find the weakest assumption');
    await f.page.waitForTimeout(500);
    assert.equal(agents(await f.scene()).length, 0, 'an unconfirmed draft must never enter the saved scene');
    assert.equal(await f.page.getByRole('button', { name: 'Inspect Critic', exact: true }).count(), 0, 'an unconfirmed draft must have no board tab');
    assert.equal(f.chats.length, 0);
    if (confirmation === 'Enter') await task.press('Enter');
    else await f.page.getByRole('button', { name: 'Add', exact: true }).click();
    await f.page.getByRole('button', { name: 'Inspect Critic', exact: true }).waitFor();
    await f.page.getByRole('button', { name: 'Done', exact: true }).click();
    await f.waitFor(s => agents(s)[0]?.customData.loveAgent.task === 'Find the weakest assumption', 'chosen task did not persist');
    assert.equal(agents(await f.scene()).length, 1, 'confirmation must create exactly one card');
    assert.equal(await f.page.getByRole('button', { name: 'Inspect Critic', exact: true }).count(), 1);
    await f.page.reload();
    if (surface === 'embedded') await f.open(f.page);
    else await f.page.locator('.excalidraw canvas').first().waitFor();
    await f.page.getByRole('button', { name: 'Inspect Critic', exact: true }).click();
    assert.equal(await task.inputValue(), 'Find the weakest assumption');
    assert.equal(await f.page.getByRole('menu', { name: 'Agents', exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const dismissal of ['Escape', 'outside drag']) test(`${dismissal} cancels three agent drafts without creating cards, tabs or drawings`, async () => {
  const f = await loveSpotFixture();
  try {
    const { page } = f; await f.open(page); await f.draw(page);
    const original = await f.waitFor(s => s.elements.some(e => e.type === 'rectangle' && !e.isDeleted), 'initial drawing must persist');
    for (let i = 0; i < 3; i++) {
      await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Add Researcher', exact: true }).click();
      await page.getByRole('textbox', { name: 'Task', exact: true }).fill(`Cancelled task ${i}`);
      if (dismissal === 'Escape') await page.keyboard.press('Escape');
      else {
        const board = await page.locator('.excalidraw').boundingBox();
        await page.mouse.move(board.x + 650, board.y + 400); await page.mouse.down();
        await page.mouse.move(board.x + 750, board.y + 500, { steps: 8 }); await page.mouse.up();
      }
      assert.equal(await page.getByRole('textbox', { name: 'Task', exact: true }).count(), 0, 'the draft must disappear');
      await page.waitForTimeout(500);
      assert.equal(await page.getByRole('button', { name: 'Inspect Researcher', exact: true }).count(), 0);
      assert.deepEqual((await f.scene()).elements, original.elements, 'cancel must neither add nor alter board elements');
    }
    assert.equal(f.chats.length, 0);
    await f.draw(page, 100);
    await f.waitFor(s => s.elements.filter(e => e.type === 'rectangle' && !e.isDeleted).length === 2, 'drawing must work after cancellation');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`agent menu contains every name and description at minimum window width · ${colorScheme}`, async () => {
  const f = await loveSpotFixture({ colorScheme });
  try {
    const { page } = f;
    await page.goto(new URL('love-spot.html', f.url).href);
    await page.locator('.excalidraw canvas').first().waitFor();
    await page.setViewportSize({ width: 545, height: 436 });
    await page.waitForTimeout(250);
    const trigger = page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true });
    await trigger.click();
    const picker = page.getByRole('menu', { name: 'Agents', exact: true });
    const overflow = await picker.evaluate(panel => {
      const bounds = panel.getBoundingClientRect();
      return [...panel.querySelectorAll('strong,small')].filter(el => {
        const r = el.getBoundingClientRect();
        return el.scrollWidth > el.clientWidth + 1 || r.left < bounds.left || r.right > bounds.right;
      }).map(el => el.textContent);
    });
    assert.deepEqual(overflow, [], 'every character name and description must fit');
    const output = path.join(process.env.HOME, '.cache/elpis-tests/love-confirm');
    await fs.mkdir(output, { recursive: true });
    for (const width of [545, 760, 1280]) {
      await page.setViewportSize({ width, height: width === 545 ? 436 : 900 });
      await page.screenshot({ path: path.join(output, `menu-${colorScheme}-${width}.png`) });
    }
    await page.getByRole('menuitem', { name: 'Add Critic', exact: true }).click();
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Challenge the weakest assumption');
    for (const width of [545, 760, 1280]) {
      await page.setViewportSize({ width, height: width === 545 ? 436 : 900 });
      const form = page.locator('.love-agent-draft form');
      assert.ok(await form.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'the draft must fit');
      await page.screenshot({ path: path.join(output, `draft-${colorScheme}-${width}.png`) });
    }
    await page.keyboard.press('Escape');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

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
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Review our shared idea');
    await page.getByRole('textbox', { name: 'Task', exact: true }).press('Enter');
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
    // The characters Masih accepted (18 Oct), made by image generation and traced, not the old drawn faces.
    assert.ok(portraits.every(src => src.startsWith('data:image/png;base64,')), 'the portraits are the new character art');
    await page.getByRole('menuitem', { name: 'Add Researcher', exact: true }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'Run connected agents', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Give Researcher a task' }).waitFor();
    assert.deepEqual(await f.acp(), [], 'invalid graph must not start agents');
    await page.getByRole('textbox', { name: 'Task', exact: true }).fill('Trace this unique board seed');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.love-agent-toolbar').getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Add Reviewer', exact: true }).click();
    await page.getByRole('button', { name: 'Add', exact: true }).click();
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
    const prompts = (await f.acp()).filter(message => message.method === 'session/prompt').map(message => message.params.prompt[0].text);
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
    const draft = page.getByRole('textbox', { name: 'Task', exact: true });
    await draft.fill('[permission] Save the plan'); await draft.press('Enter');
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
