// The agents canvas: every agent writes and Elpis checks each one after it; ready-made architectures, agents wired
// by dependency, loops refused, the graph kept on this device, and a run that sends Elpis's work graph (each writer
// with its check) and shows each agent's state live. Synthetic HTTP fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseOption, optionsCut } = require('./controls.cjs');
const { planFor } = require('./canvas-fixture.cjs');

test('agents canvas: writers with automatic checks, architectures, wiring, persistence, a live run, the command bar', async () => {
  const root = { id: 'root', name: 'Canvas run', cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const posts = [], plans = []; let polls = 0, ran = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname !== '/api/session') posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : null });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }, { id: 'sol', model: 'gpt-6.1-sol', displayName: 'Sol 6.1', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium' }], nextCursor: null });
    if (url.pathname === '/api/settings') return json({ main: { model: 'gpt-6.1-sol', provider: 'openai' }, background: {}, smartPrune: { enabled: false, explicitOverride: {} }, memory: {}, write: { available: false, reason: '' }, agents: { graph: 256, atOnce: 4, source: 'agents.max_threads' } });
    // The project's folders, which the canvas offers as what an agent may write.
    if (url.pathname === '/api/canvas/plan') { const body = JSON.parse(raw); plans.push(body); return json(planFor(body)); }
    if (url.pathname === '/api/folders') return url.searchParams.get('cwd') === '/tmp/demo' ? json({ data: ['docs', 'src', 'src/lib', 'tests'] }) : (res.statusCode = 400, json({ error: 'cwd must be an existing directory' }));
    if (url.pathname === '/api/threads' && req.method === 'POST') return json({ thread: root });
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/workflows/run') { ran = JSON.parse(raw); return json({ graphId: 'g1', threadId: 'root', turnId: 't1' }); }
    if (url.pathname === '/api/workflows') {
      polls++;
      if (!ran) return json({ data: [] });
      // The first writer is done and its check runs, then passes; everything after it runs.
      const state = id => ({ [ran.tasks[0].id]: 'succeeded', [ran.tasks[1].id]: polls > 1 ? 'succeeded' : 'running' }[id] ?? (polls > 1 ? 'running' : 'pending'));
      return json({ data: [{ id: 'g1', name: ran.name, status: 'running', maxConcurrency: 3, error: null, eventCount: 3, tasks: ran.tasks.map(task => ({ id: task.id, kind: task.kind, title: task.title, status: state(task.id), dependencies: task.dependsOn, assignedThreadId: task.id === ran.tasks[0].id ? 'child-first' : null, provider: null, model: null, result: null, evidence: [], failureReason: null })) }] });
    }
    // The first agent's own chat, as its dashboard reads it.
    if (url.pathname === '/api/threads/child-first') return json({ thread: { ...root, id: 'child-first' }, data: [
      { turnId: 't', item: { id: 'i1', type: 'commandExecution', command: 'rg lexer' }, startedAtMs: 1000, completedAtMs: 4000 },
      { turnId: 't', item: { id: 'i2', type: 'agentMessage', text: 'Part 1 is built: the lexer now reads numbers.' }, startedAtMs: 4000, completedAtMs: 65000 }], nextCursor: null });
    if (url.pathname.startsWith('/api/threads/root')) return json({ thread: root, data: [], nextCursor: null });
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.setDefaultTimeout(6000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    // A project is open: agents write inside it.
    await page.addInitScript(() => { if (!localStorage.getItem('elpis-projects-v1')) localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'p1', name: 'demo', cwd: '/tmp/demo' }], selectedId: 'p1' })); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Agents canvas', exact: true }); await canvas.waitFor();
    // Agents and the wires between them; the Mother and her wires are counted on their own.
    const nodes = canvas.locator('.react-flow__node-agent'), edges = canvas.locator('.react-flow__edge:not(.canvas-edge-mother)');
    const node = title => canvas.locator('.react-flow__node').filter({ hasText: title });
    // New agents that land out of view move the view to them; fitting shows the whole graph again.
    const fit = async () => { await canvas.getByRole('button', { name: /fit view/i }).click(); await page.waitForTimeout(400); };
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')));
    const agentsNamed = async () => { await page.waitForTimeout(400); return (await saved()).nodes.filter(item => item.type === 'agent'); };
    // Each wait names itself, so a failure says which step broke.
    const until = async (label, condition, timeout) => { try { await page.waitForFunction(condition, null, timeout ? { timeout } : undefined); } catch (error) { throw Error(`${label}: ${error.message.split('\n')[0]}`); } };

    // A fresh canvas starts split by parts, as Anthropic advises. The list marks what is on the board and draws each
    // architecture's shape: the Mother, then a column per wave. Every agent writes.
    const loaded = canvas.locator('.canvas-template[aria-current="true"]');
    assert.match(await loaded.innerText(), /^Split by parts\s*On the board/i);
    assert.deepEqual(await nodes.locator('.agent-node-title').allInnerTexts(), ['Part 1', 'Part 2', 'Part 3', 'Join the parts']);
    const voting = canvas.locator('.canvas-template').filter({ hasText: 'Voting' });
    assert.deepEqual(await voting.locator('.canvas-shape > span').evaluateAll(columns => columns.map(column => column.children.length)), [1, 3, 1]);
    assert.match(await canvas.locator('.canvas-template').filter({ hasText: 'Plan → Build' }).innerText(), /Anthropic finds each handoff loses context/);
    assert.doesNotMatch(await voting.innerText(), /handoff/);

    // Loading another architecture replaces the board, so Undo is offered.
    await canvas.getByRole('button', { name: /Plan → Build/ }).click();
    await node('Write the plan').waitFor();
    assert.match(await loaded.innerText(), /^Plan → Build\s*On the board/i);
    await canvas.getByRole('status').filter({ hasText: 'Loaded Plan → Build.' }).getByRole('button', { name: 'Undo', exact: true }).click();
    await node('Part 1').waitFor();
    assert.match(await loaded.innerText(), /^Split by parts/i);
    assert.equal(await nodes.count(), 4);
    assert.equal(await edges.count(), 3);
    assert.deepEqual(await nodes.evaluateAll(list => [...new Set(list.map(item => item.querySelector('[data-kind]')?.dataset.kind))]), ['agent']);

    // Nothing on the board covers anything else, down to a small window (Masih's is about 1130×660): the zoom buttons,
    // the minimap and the Add bar, whose buttons all stay in the window.
    for (const [width, height] of [[1130, 660], [960, 600], [1440, 900]]) {
      await page.setViewportSize({ width, height }); await page.waitForTimeout(200);
      const boxes = await page.evaluate(() => Object.fromEntries(['.react-flow__controls', '.canvas-minimap', '.canvas-toolbar'].map(selector => {
        const box = document.querySelector(selector).getBoundingClientRect(); return [selector, { left: box.left, top: box.top, right: box.right, bottom: box.bottom }]; })));
      const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      for (const [a, b] of [['.react-flow__controls', '.canvas-minimap'], ['.react-flow__controls', '.canvas-toolbar'], ['.canvas-minimap', '.canvas-toolbar']]) assert.ok(!meet(boxes[a], boxes[b]), `${a} and ${b} overlap at ${width}×${height}`);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.canvas-toolbar button')].filter(button => { const box = button.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth || box.bottom > innerHeight; }).map(button => button.textContent)), [], `toolbar buttons outside the window at ${width}×${height}`);
    }

    // The project the agents write in is chosen in the header, with the app's own project menu.
    assert.match(await canvas.locator('.canvas-header').innerText(), /demo/);

    // The Mother leads every graph: one node, wired to the first wave, and she can't be deleted. A click on her opens
    // her panel: the run's settings, a brief every agent gets and her chat's model.
    const mother = canvas.locator('.react-flow__node-mother');
    assert.equal(await mother.count(), 1);
    assert.match(await mother.innerText(), /Mother[\s\S]*4 of 10 agents/i);
    assert.equal(await canvas.locator('.react-flow__edge.canvas-edge-mother').count(), 3);
    await mother.click(); await page.keyboard.press('Delete');
    assert.equal(await mother.count(), 1, 'the Mother survives Delete');
    const motherPanel = canvas.getByRole('complementary', { name: 'Mother', exact: true });
    await motherPanel.getByRole('textbox', { name: 'Goal', exact: true }).fill('Keep the public API unchanged.');
    await chooseOption(motherPanel.getByRole('combobox', { name: 'Her model', exact: true }), '|gpt-6-luna');
    assert.equal(await motherPanel.getByRole('textbox', { name: 'Max agents', exact: true }).inputValue(), '10');
    await motherPanel.getByText('Not started. Every agent\'s report arrives here once the graph runs.').waitFor();
    await motherPanel.getByRole('button', { name: 'Done', exact: true }).click();

    // Kahn's waves: each agent shows when it starts, and the run order lists them. Every wire carries chevrons
    // pointing its way; none stream before a run.
    const wave = async title => (await node(title).locator('.agent-node-kind').innerText()).match(/wave (\d+)/i)?.[1];
    assert.deepEqual([await wave('Part 1'), await wave('Part 3'), await wave('Join the parts')], ['1', '1', '2']);
    assert.deepEqual(await canvas.getByRole('region', { name: 'Run order' }).locator('li').allInnerTexts(), ['WAVE 1\nPart 1, Part 2, Part 3', 'WAVE 2\nJoin the parts']);
    // The critical path: the longest chain, which sets how many rounds the run takes; hovering it lights its wires.
    const critical = canvas.locator('.canvas-critical');
    assert.equal(await critical.innerText(), 'CRITICAL PATH · 2 ROUNDS\nPart 1 → Join the parts');
    await critical.hover();
    assert.equal(await canvas.locator('.react-flow__edge.selected').count(), 1, 'its one wire is lit');
    await page.mouse.move(0, 0);
    assert.equal(await canvas.locator('.canvas-chevron').count(), 3 * 6);
    assert.equal(await canvas.locator('.canvas-chevron[data-live]').count(), 0);

    // Selecting an agent opens it: its prompt, model, the project folders it may write, and what its check holds it to.
    await node('Join the parts').click();
    const inspector = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    assert.match(await inspector.locator('.hud-menu-title').innerText(), /Checked after it runs/i);
    assert.equal(await node('Join the parts').locator('.agent-node-mark').getAttribute('aria-label'), 'Checked after it runs');
    // Every choice in every menu reads in full: none is cut off by the panel or hidden under the check mark.
    for (const name of ['Model', 'Add a folder']) assert.deepEqual(await optionsCut(inspector.getByRole('combobox', { name, exact: true })), [], `${name} menu`);
    await chooseOption(inspector.getByRole('combobox', { name: 'Add a folder', exact: true }), 'src');
    await inspector.getByRole('group', { name: 'May write' }).getByText('src', { exact: true }).waitFor();
    assert.equal(await inspector.getByRole('textbox', { name: 'Done when', exact: true }).getAttribute('placeholder'), 'The change builds and its tests pass.');

    // Add an agent from the Add bar and wire Join the parts to it by dragging between their dots.
    await canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    await until('the agent is added', () => document.querySelectorAll('.react-flow__node-agent').length === 5);
    await fit();
    const drag = async (from, to) => {
      const a = await node(from).locator('.react-flow__handle.source').boundingBox(), b = await node(to).locator('.react-flow__handle.target').boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 }); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 }); await page.mouse.up();
    };
    await drag('Join the parts', 'New agent');
    await until('the drag made a wire', () => document.querySelectorAll('.react-flow__edge:not(.canvas-edge-mother)').length === 4);
    assert.equal(await wave('New agent'), '3');

    // A wire that would make a loop is refused, and says why.
    await fit();
    await drag('New agent', 'Part 1');
    await canvas.getByText('That wire would make a loop', { exact: false }).waitFor();
    assert.equal(await edges.count(), 4);

    // The graph is kept on this device.
    await page.waitForTimeout(600); await page.reload();
    await page.getByRole('button', { name: 'Canvas', exact: true }).click(); await canvas.waitFor();
    await until('the graph came back after a restart', () => document.querySelectorAll('.react-flow__node-agent').length === 5 && document.querySelectorAll('.react-flow__edge:not(.canvas-edge-mother)').length === 4 && document.querySelectorAll('.react-flow__node-mother').length === 1);

    // Several agents share a folder in one step: Shift+drag selects them all, and the group panel adds it to each.
    await fit();
    const board = await canvas.locator('.react-flow__pane').boundingBox();
    const box = async () => {
      const area = await canvas.locator('.react-flow__pane').boundingBox();
      await page.keyboard.down('Shift');
      await page.mouse.move(area.x + 4, area.y + 4); await page.mouse.down();
      await page.mouse.move(area.x + area.width - 4, area.y + area.height - 4, { steps: 8 }); await page.mouse.up();
      await page.keyboard.up('Shift');
    };
    await box();
    const group = canvas.getByRole('complementary', { name: 'Selected agents', exact: true });
    await group.getByText(/^5 agents selected$/i).waitFor();
    await chooseOption(group.getByRole('combobox', { name: 'Add a folder', exact: true }), 'src/lib');
    await page.waitForTimeout(400);
    assert.deepEqual((await saved()).nodes.filter(item => item.type === 'agent').map(item => item.data.writeScopes), [['src/lib'], ['src/lib'], ['src/lib'], ['src', 'src/lib'], ['src/lib']]);
    await group.getByRole('button', { name: 'Done', exact: true }).click();
    // The joiner thinks harder: Sol at high thinking.
    await node('Join the parts').click();
    await chooseOption(inspector.getByRole('combobox', { name: 'Model', exact: true }), '|gpt-6.1-sol');
    await chooseOption(inspector.getByRole('combobox', { name: 'Thinking', exact: true }), 'high');

    // Run: a new chat holds the run. Elpis gets each agent as a writer followed by its own read-only check, and an agent
    // wired after another waits for that one's check, so it builds on checked work.
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await until('an agent shows as running', () => document.querySelector('.react-flow__node-agent [data-status="running"]'));
    assert.equal(await canvas.locator('.react-flow__node-mother [data-status]').getAttribute('data-status'), 'running', 'the Mother shows the run');
    assert.equal(ran.rootThreadId, 'root');
    assert.equal(ran.tasks.length, 10);
    const byTitle = Object.fromEntries(ran.tasks.map(task => [task.title, task]));
    const join = byTitle['Join the parts'], joinCheck = byTitle['Check: Join the parts'];
    assert.deepEqual([join.kind, join.writeScopes, join.acceptanceCriteria], ['implement', ['src', 'src/lib'], ['The whole suite passes']]);
    assert.deepEqual(join.dependsOn, ['Part 1', 'Part 2', 'Part 3'].map(title => byTitle[`Check: ${title}`].id));
    assert.deepEqual([joinCheck.kind, joinCheck.dependsOn, joinCheck.writeScopes], ['verify', [join.id], []]);
    assert.match(joinCheck.instruction, /^Check the work of “Join the parts”[\s\S]*The whole suite passes/);
    assert.deepEqual(byTitle['New agent'].dependsOn, [joinCheck.id]);
    // The new agent had no prompt: Elpis filled it from the run's goal before the run, and nothing else changed.
    assert.deepEqual([plans.length, plans[0].goal, plans[0].agents.find(item => item.title === 'New agent').prompt], [1, 'Keep the public API unchanged.', '']);
    assert.equal(byTitle['New agent'].instruction, 'Goal of the whole run: Keep the public API unchanged.\n\nDo New agent');
    assert.deepEqual(byTitle['New agent'].acceptanceCriteria, ['The change builds and its tests pass.']);
    // An agent's thinking level goes with it; one left at the model's default is not sent.
    assert.deepEqual([join.model, join.reasoningEffort, byTitle['New agent'].reasoningEffort], ['gpt-6.1-sol', 'high', undefined]);
    // The Mother is the run's chat: it starts with her model, and her brief as its instructions.
    assert.deepEqual(['model', 'instructions'].map(key => posts.find(post => post.path === '/api/threads').body[key]), ['gpt-6-luna', 'Keep the public API unchanged.']);
    // The ring on an agent's corner is its check: Part 1 is done, then its check passes and the joiner runs.
    assert.equal(await node('Part 1').locator('[data-status]').first().getAttribute('data-status'), 'succeeded');
    await canvas.getByText(/1 of 5 done/).waitFor({ timeout: 8000 });
    assert.equal(await node('Part 1').locator('.agent-node-mark').getAttribute('aria-label'), 'Check passed');
    // A live wire streams its chevrons: Part 1's checked work feeds the running joiner.
    assert.ok(await canvas.locator('.canvas-chevron[data-live]').count() > 0, 'live wires stream');
    assert.equal(ran.maxConcurrency, 3);

    // The command bar, typed AutoCAD-style: Tab over the board, then what you want done.
    const adder = canvas.getByRole('dialog', { name: 'Add agents', exact: true }), command = adder.getByRole('textbox', { name: 'Command', exact: true });
    const plan = adder.getByLabel('Will add');
    await page.mouse.click(board.x + 60, board.y + board.height - 140);
    await page.keyboard.press('Tab');
    await command.waitFor();
    await page.keyboard.type('Fix the parser');
    // Free text that is no command goes to Elpis, which acts on the board: here it adds the agent asked for.
    assert.equal(await plan.innerText(), 'Elpis\nwill do it: design or change the team from what you wrote');
    await page.keyboard.press('Enter');
    await adder.waitFor({ state: 'hidden' });
    await until('the prompted agent was added', () => document.querySelectorAll('.react-flow__node-agent').length === 6);
    assert.deepEqual((await agentsNamed()).filter(item => item.data.title === 'Fix the parser').map(item => item.data.instruction), ['Fix the parser']);
    // A count and a model, and Enter asks for the prompts, one per line; a missing one can be written later.
    await page.keyboard.press('Tab'); await command.waitFor();
    await page.keyboard.type('3 luna');
    assert.equal(await plan.innerText(), '3 × Agent\nLuna 6 · OpenAI');
    await page.keyboard.press('Enter');
    await adder.getByRole('textbox', { name: 'Prompts, one per line' }).waitFor();
    await page.keyboard.type('Fix the lexer'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Fix the docs');
    await adder.getByText('3 agents: 2 with a prompt, 1 still to write').waitFor();
    await page.keyboard.press('Enter');
    await adder.waitFor({ state: 'hidden' });
    await until('three agents were added', () => document.querySelectorAll('.react-flow__node-agent').length === 9);
    const added = (await agentsNamed()).filter(item => item.data.model === 'gpt-6-luna');
    assert.deepEqual(added.map(item => [item.data.title, item.data.instruction]), [['Fix the lexer', 'Fix the lexer'], ['Fix the docs', 'Fix the docs'], ['New agent 3', '']]);

    // Ctrl+A in a text field selects its text and opens nothing (on the board it selects every agent: canvas-basics).
    // Escape closes the bar; a double-click opens it.
    await fit();
    await node('Fix the lexer').click();
    await inspector.getByRole('textbox', { name: 'Prompt', exact: true }).focus();
    await page.keyboard.press('Control+a');
    assert.equal(await adder.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)), 'Fix the lexer');
    // The header wraps to two rows while a run shows its status, so the board is measured again.
    const now = await canvas.locator('.react-flow__pane').boundingBox();
    await page.mouse.dblclick(now.x + 30, now.y + 30);
    await command.waitFor(); await page.keyboard.press('Escape'); await adder.waitFor({ state: 'hidden' });

    // Counts are typed in the Mother's panel, and only what Elpis allows is taken, with the reason when it is not. The
    // header's Mother button opens her panel wherever she is on the board.
    const motherButton = canvas.getByRole('button', { name: 'Mother', exact: true });
    await motherButton.click();
    const maxField = motherPanel.getByRole('textbox', { name: 'Max agents', exact: true }), atOnce = motherPanel.getByRole('textbox', { name: 'At once', exact: true });
    await maxField.fill('300');
    await canvas.getByText('Elpis runs at most 256 tasks in a graph: 128 agents, each with its check.').waitFor();
    await maxField.fill('5');
    await canvas.getByText('The graph already has 9 agents; remove some first.').waitFor();
    await maxField.fill('13'); await maxField.blur();
    await page.waitForTimeout(400);
    assert.equal((await saved()).maxAgents, 13);
    await atOnce.fill('6');
    await canvas.getByText('Elpis allows 4 at once here (agents.max_threads).').waitFor();
    await atOnce.fill('4'); await atOnce.blur();
    assert.equal(await atOnce.inputValue(), '4');

    // Browsing by keyboard: Tab on the board opens the bar; with one provider its models are listed; → opens a model's
    // thinking levels; Enter takes one, and Enter again asks for the prompts.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    await command.waitFor();
    await page.keyboard.type('2');
    assert.deepEqual(await adder.getByRole('listbox', { name: 'Models' }).getByRole('option').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Default model', 'Luna 6', 'Sol 6.1']);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
    assert.deepEqual(await adder.getByRole('listbox', { name: 'Thinking levels' }).getByRole('option').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Low thinking', 'Medium thinking', 'High thinking']);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await command.inputValue(), '2 gpt-6.1-sol high ');
    await page.keyboard.press('Enter');
    await adder.getByRole('textbox', { name: 'Prompts, one per line' }).waitFor();
    await page.keyboard.press('Enter');
    await until('two agents on Sol were added', () => document.querySelectorAll('.react-flow__node-agent').length === 11);
    const onSol = (await agentsNamed()).filter(item => item.data.model === 'gpt-6.1-sol' && item.data.title !== 'Join the parts');
    assert.deepEqual(onSol.map(item => [item.data.effort, item.data.instruction]), [['high', ''], ['high', '']]);

    // A click on an agent's dot opens the bar there; prompts after a colon add the agents at once, and they wait for
    // the agent whose dot it was. After a colon, words the bar can't place are listed, never guessed.
    await fit();
    const joinDot = await node('Join the parts').locator('.react-flow__handle.source').boundingBox();
    await page.mouse.click(joinDot.x + joinDot.width / 2, joinDot.y + joinDot.height / 2);
    await command.waitFor();
    await page.keyboard.type('luna zzz:');
    await adder.getByText('Not understood: zzz').waitFor();
    for (let index = 0; index < 5; index++) await page.keyboard.press('Backspace');
    await page.keyboard.type(': Patch what the suite found; Patch the docs');
    await page.keyboard.press('Enter');
    await until('the dot added two agents', () => document.querySelectorAll('.react-flow__node-agent').length === 13);
    await page.waitForTimeout(400);
    const graph = await saved(), joiner = graph.nodes.find(item => item.data?.title === 'Join the parts');
    const patches = graph.nodes.filter(item => item.data?.title?.startsWith('Patch'));
    assert.deepEqual(patches.map(item => [item.data.title, item.data.model]), [['Patch what the suite found', 'gpt-6-luna'], ['Patch the docs', 'gpt-6-luna']]);
    assert.ok(patches.every(patch => graph.edges.some(edge => edge.source === joiner.id && edge.target === patch.id)), 'both wait for Join the parts');

    // A wire let go on empty board opens the bar too; the graph is now at its limit, so the bar says so.
    await fit();
    const handle = await node('Join the parts').locator('.react-flow__handle.source').boundingBox();
    // Let go on empty board: the first point right of the dot, then below it, where nothing but the board is.
    const empty = await page.evaluate(({ x, y }) => { const bare = (px, py) => document.elementFromPoint(px, py)?.classList.contains('react-flow__pane'); for (let dy = 0; dy < 400; dy += 30) for (let dx = 80; dx < 500; dx += 30) { const px = x + dx, py = y + dy; if ([[0, 0], [70, 0], [-70, 0], [0, 70], [0, -70]].every(([ox, oy]) => bare(px + ox, py + oy))) return { x: px, y: py }; } return null; }, { x: handle.x, y: handle.y });
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(empty.x, empty.y, { steps: 6 }); await page.mouse.up();
    await adder.getByText('No room for more agents').waitFor();
    await page.keyboard.press('Escape');
    await canvas.getByRole('button', { name: 'Add agent', exact: true }).click();
    await canvas.getByText('The graph is at its limit of 13 agents. Raise Max agents to add more.').waitFor();

    // An agent's dashboard (double-click, or Enter on the selected agent): its wiring, its check and its live work.
    await fit(); await node('Part 1').dblclick();
    const dash = canvas.getByRole('dialog', { name: 'Part 1 dashboard' });
    await dash.getByText('Part 1 is built: the lexer now reads numbers.').waitFor();
    assert.match(await dash.innerText(), /Worked for 1m 4s · Ran a command/);
    assert.match(await dash.innerText(), /Feeds\s+Join the parts/);
    assert.match(await dash.innerText(), /Its check\s+Check passed/);
    await page.keyboard.press('Escape'); await dash.waitFor({ state: 'hidden' });
    await node('Fix the docs').click(); await page.keyboard.press('Enter');
    await canvas.getByRole('dialog', { name: 'Fix the docs dashboard' }).getByText('Not started. What it does shows here once the graph runs.').waitFor();

    // Shift+Enter in the command line starts the next agent's prompt; it never adds the agents early.
    await page.keyboard.press('Escape');
    await motherButton.click(); await maxField.fill('20');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab'); await command.waitFor();
    await page.keyboard.type('2 luna'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Tidy the lexer');
    await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Tidy the parser');
    assert.equal(await nodes.count(), 13, 'Shift+Enter added nothing');
    assert.equal(await plan.innerText(), '2 × Agent\nLuna 6 · OpenAI\n2 prompts');
    // The command line grows with its lines: every line shows, none is squashed or scrolled away.
    assert.deepEqual(await command.evaluate(field => [field.scrollHeight <= field.clientHeight + 1, field.clientHeight > 50]), [true, true]);
    await page.keyboard.press('Enter');
    await until('the two typed agents were added', () => document.querySelectorAll('.react-flow__node-agent').length === 15);
    // If they landed past the board's edge, the view moved to show them.
    await page.waitForTimeout(400);
    for (const title of ['Tidy the lexer', 'Tidy the parser']) { const at = await node(title).boundingBox(), area = await canvas.locator('.react-flow').boundingBox(); assert.ok(at.x >= area.x && at.x + at.width <= area.x + area.width, `${title} is in view`); }

    // Shift+click adds to the selection, and the selected agents are edited together.
    await node('Tidy the lexer').click(); await node('Tidy the parser').click({ modifiers: ['Shift'] });
    await group.getByText(/^2 agents selected$/i).waitFor();
    await chooseOption(group.getByRole('combobox', { name: 'Model', exact: true }), '|gpt-6.1-sol');
    await chooseOption(group.getByRole('combobox', { name: 'Add a folder', exact: true }), 'docs');
    await page.waitForTimeout(400);
    const tidy = async () => (await saved()).nodes.filter(item => item.data?.title?.startsWith('Tidy'));
    assert.deepEqual((await tidy()).map(item => [item.data.model, item.data.writeScopes]), [['gpt-6.1-sol', ['docs']], ['gpt-6.1-sol', ['docs']]]);
    // Shift+drag draws a box, and everything inside it is selected.
    await group.getByRole('button', { name: 'Done', exact: true }).click();
    await fit(); await box();
    const boxed = await canvas.locator('.react-flow__node-agent.selected').count();
    assert.ok(boxed > 2, `the box selected ${boxed} agents`);
    await group.getByText(new RegExp(`^${boxed} agents selected$`, 'i')).waitFor();
    // Delete removes the whole selection.
    await group.getByRole('button', { name: 'Done', exact: true }).click();
    await node('Tidy the lexer').click(); await node('Tidy the parser').click({ modifiers: ['Shift'] });
    await page.keyboard.press('Delete');
    await until('both were deleted', () => document.querySelectorAll('.react-flow__node-agent').length === 13);

    // A click on a wire opens its menu: insert agents on it (they take its place), or remove it.
    await fit();
    const drawn = await saved(), titled = title => drawn.nodes.find(item => item.data?.title === title).id;
    const wireOf = (from, to) => canvas.locator(`.react-flow__edge[data-id="${drawn.edges.find(edge => edge.source === titled(from) && edge.target === titled(to)).id}"]`);
    // A wire is clicked halfway along it, where a user aims; its box's centre can be off the curve.
    // The Mother's wires fan out from one dot and overlap near her, so hers are clicked near their agent.
    // Elbow wires into one agent share their last stretch, so a wire is clicked where it alone shows, from `along` on.
    const clickWire = async (wire, along = 0.5) => {
      const point = await wire.locator('.react-flow__edge-path').evaluate((path, along) => { const m = path.getScreenCTM(), own = path.closest('.react-flow__edge'); for (let step = 0; step < 40; step++) { const at = path.getPointAtLength(path.getTotalLength() * ((along + step / 40) % 1)), x = at.x * m.a + at.y * m.c + m.e, y = at.x * m.b + at.y * m.d + m.f; if (document.elementFromPoint(x, y)?.closest('.react-flow__edge') === own) return { x, y }; } return null; }, along);
      await page.mouse.click(point.x, point.y);
    };
    await clickWire(wireOf('Part 1', 'Join the parts'));
    const wireMenu = canvas.getByRole('menu', { name: 'Wire', exact: true });
    assert.deepEqual(await wireMenu.getByRole('menuitem').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Insert agents here', 'Make it two-way', 'Remove wire']);
    await page.keyboard.press('Enter');
    await command.waitFor();
    await page.keyboard.type('Review part 1'); await page.keyboard.press('Enter');
    await until('the inserted agent was added', () => document.querySelectorAll('.react-flow__node-agent').length === 14);
    await page.waitForTimeout(400);
    const inserted = await saved(), id = title => inserted.nodes.find(item => item.data?.title === title).id;
    const wired = (from, to) => inserted.edges.some(edge => edge.source === id(from) && edge.target === id(to));
    assert.deepEqual([wired('Part 1', 'Review part 1'), wired('Review part 1', 'Join the parts'), wired('Part 1', 'Join the parts')], [true, true, false]);
    await fit();
    const wires = await edges.count();
    await clickWire(wireOf('Part 2', 'Join the parts'));
    await wireMenu.getByRole('menuitem', { name: /Remove wire/ }).click();
    await wireMenu.waitFor({ state: 'hidden' }); await page.waitForTimeout(100);
    assert.equal(await edges.count(), wires - 1, 'the wire was removed');
    // The Mother's dotted wires take a click too: agents inserted there start first, and her agent waits for them.
    await clickWire(canvas.locator(`.react-flow__edge[data-id="mother->${id('Part 3')}"]`), 0.85);
    assert.deepEqual(await wireMenu.getByRole('menuitem').allInnerTexts(), ['Insert agents here\nBefore Part 3, started by the Mother']);
    await page.keyboard.press('Enter'); await command.waitFor();
    await page.keyboard.type('Read the issue'); await page.keyboard.press('Enter');
    await until('the agent before Part 3 was added', () => document.querySelectorAll('.react-flow__node-agent').length === 15);
    await page.waitForTimeout(400);
    const first = await saved(), firstId = title => first.nodes.find(item => item.data?.title === title).id;
    assert.ok(first.edges.some(edge => edge.source === firstId('Read the issue') && edge.target === firstId('Part 3')), 'Part 3 waits for the new agent');
    assert.match(await node('Part 3').innerText(), /wave 2/i);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
