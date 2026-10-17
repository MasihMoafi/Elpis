// The agents canvas: ready-made architectures, agents as nodes wired by dependency, loops refused, the graph kept
// on this device, and a run that sends Elpis's work graph and shows each agent's state live. Synthetic HTTP fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { optionsCut } = require('./controls.cjs');

test('agents canvas: architecture, add and wire agents, refuse loops, persist, run and follow it live', async () => {
  const root = { id: 'root', name: 'Canvas run', cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const posts = []; let polls = 0, ran = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname !== '/api/session') posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : null });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }, { id: 'sol', model: 'gpt-6.1-sol', displayName: 'Sol 6.1', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'medium' }], nextCursor: null });
    if (url.pathname === '/api/settings') return json({ main: { model: 'gpt-6.1-sol', provider: 'openai' }, background: {}, smartPrune: { enabled: false, explicitOverride: {} }, memory: {}, write: { available: false, reason: '' }, agents: { graph: 256, atOnce: 4, source: 'agents.max_threads' } });
    if (url.pathname === '/api/threads' && req.method === 'POST') return json({ thread: root });
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/workflows/run') { ran = JSON.parse(raw); return json({ graphId: 'g1', threadId: 'root', turnId: 't1' }); }
    if (url.pathname === '/api/workflows') {
      polls++;
      if (!ran) return json({ data: [] });
      const state = id => ({ [ran.tasks[0].id]: 'succeeded', [ran.tasks[1].id]: polls > 1 ? 'succeeded' : 'running' }[id] ?? (polls > 1 ? 'running' : 'pending'));
      return json({ data: [{ id: 'g1', name: ran.name, status: 'running', maxConcurrency: 3, error: null, eventCount: 3, tasks: ran.tasks.map(task => ({ id: task.id, kind: task.kind, title: task.title, status: state(task.id), dependencies: task.dependsOn, assignedThreadId: task.id === ran.tasks[0].id ? 'child-plan' : null, provider: null, model: null, result: null, evidence: [], failureReason: null })) }] });
    }
    // The planner's own chat, as its dashboard reads it.
    if (url.pathname === '/api/threads/child-plan') return json({ thread: { ...root, id: 'child-plan' }, data: [
      { turnId: 't', item: { id: 'i1', type: 'commandExecution', command: 'rg lexer' }, startedAtMs: 1000, completedAtMs: 4000 },
      { turnId: 't', item: { id: 'i2', type: 'agentMessage', text: 'Plan: change lexer.rs first, then parser.rs.' }, startedAtMs: 4000, completedAtMs: 65000 }], nextCursor: null });
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
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Canvas', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Agents canvas', exact: true }); await canvas.waitFor();
    // Agents and the wires between them; the Mother and her wires are counted on their own.
    const nodes = canvas.locator('.react-flow__node-agent'), edges = canvas.locator('.react-flow__edge:not(.canvas-edge-mother)');
    const node = title => canvas.locator('.react-flow__node').filter({ hasText: title });
    const AGENTS = '.react-flow__node-agent', WIRES = '.react-flow__edge:not(.canvas-edge-mother)';
    const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')));
    // Each wait names itself, so a failure says which step broke.
    const until = async (label, condition, timeout) => { try { await page.waitForFunction(condition, null, timeout ? { timeout } : undefined); } catch (error) { throw Error(`${label}: ${error.message.split('\n')[0]}`); } };

    // A ready-made architecture fills the canvas: one explorer, two builders, a verifier.
    await canvas.getByRole('button', { name: /Plan → Build → Verify/ }).click();
    await until('the architecture has 4 agents', () => document.querySelectorAll('.react-flow__node-agent').length === 4);
    assert.equal(await edges.count(), 4);
    assert.deepEqual(await nodes.evaluateAll(list => list.map(item => item.querySelector('[data-kind]')?.dataset.kind).sort()), ['implement', 'implement', 'plan', 'verify']);

    // The Mother leads every graph: one node, wired to the first wave only, and she can't be deleted.
    const mother = canvas.locator('.react-flow__node-mother');
    assert.equal(await mother.count(), 1);
    assert.match(await mother.innerText(), /Mother[\s\S]*4 of 10 agents/i);
    assert.equal(await canvas.locator('.react-flow__edge.canvas-edge-mother').count(), 1);
    await mother.click(); await page.keyboard.press('Delete');
    assert.equal(await mother.count(), 1, 'the Mother survives Delete');

    // Kahn's waves: each agent shows when it starts, and the run order lists them.
    const wave = async title => (await node(title).locator('.agent-node-kind').innerText()).match(/wave (\d+)/i)?.[1];
    assert.deepEqual([await wave('Plan the change'), await wave('Build part one'), await wave('Build part two'), await wave('Run the suite')], ['1', '2', '2', '3']);
    assert.deepEqual(await canvas.getByRole('region', { name: 'Run order' }).locator('li').allInnerTexts(), ['WAVE 1\nPlan the change', 'WAVE 2\nBuild part one, Build part two', 'WAVE 3\nRun the suite']);
    // Every wire carries chevrons pointing its way; none stream before a run.
    assert.equal(await canvas.locator('.canvas-chevron').count(), 3 * 5);
    assert.equal(await canvas.locator('.canvas-chevron[data-live]').count(), 0);

    // Selecting an agent opens it for editing.
    await node('Run the suite').click();
    const inspector = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    // Every choice in every menu reads in full: none is cut off by the panel or hidden under the check mark.
    for (const name of ['Role', 'Model']) assert.deepEqual(await optionsCut(inspector.getByRole('combobox', { name, exact: true })), [], `${name} menu`);
    await inspector.getByRole('textbox', { name: 'Instruction', exact: true }).fill('Run every test and show the output.');

    // Add a Fix agent and wire the verifier to it by dragging between their handles.
    await canvas.getByRole('button', { name: 'Add Fix agent', exact: true }).click();
    await until('the Fix agent is added', () => document.querySelectorAll('.react-flow__node-agent').length === 5);
    const drag = async (from, to) => {
      const a = await node(from).locator('.react-flow__handle.source').boundingBox(), b = await node(to).locator('.react-flow__handle.target').boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 }); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 }); await page.mouse.up();
    };
    await drag('Run the suite', 'New Fix agent');
    await until('the drag made a wire', () => document.querySelectorAll('.react-flow__edge:not(.canvas-edge-mother)').length === 5);
    assert.equal(await wave('New Fix agent'), '4');

    // A wire that would make a loop is refused, and says why.
    await drag('New Fix agent', 'Plan the change');
    await canvas.getByText('That wire would make a loop', { exact: false }).waitFor();
    assert.equal(await edges.count(), 5);

    // The graph is kept on this device.
    await page.waitForTimeout(600); await page.reload();
    await page.getByRole('button', { name: 'Canvas', exact: true }).click(); await canvas.waitFor();
    await until('the graph came back after a restart', () => document.querySelectorAll('.react-flow__node-agent').length === 5 && document.querySelectorAll('.react-flow__edge:not(.canvas-edge-mother)').length === 5 && document.querySelectorAll('.react-flow__node-mother').length === 1);

    // An agent without an instruction stops the run before anything is sent, and says which one.
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await canvas.getByText('“New Fix agent” needs an instruction.').waitFor();
    assert.equal(ran, null);
    await node('New Fix agent').click();
    await inspector.getByRole('textbox', { name: 'Instruction', exact: true }).fill('Repair whatever the suite found.');

    // Run: a new chat holds the run; Elpis gets every agent with its dependencies.
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await until('an agent shows as running', () => document.querySelector('.react-flow__node-agent [data-status="running"]'));
    assert.equal(await canvas.locator('.react-flow__node-mother [data-status]').getAttribute('data-status'), 'running', 'the Mother shows the run');
    assert.equal(ran.rootThreadId, 'root');
    assert.equal(ran.tasks.length, 5);
    const byTitle = Object.fromEntries(ran.tasks.map(task => [task.title, task]));
    assert.deepEqual(byTitle['New Fix agent'].dependsOn, [byTitle['Run the suite'].id]);
    assert.equal(byTitle['Run the suite'].instruction, 'Run every test and show the output.');
    assert.equal(byTitle['Run the suite'].kind, 'verify');
    // A Plan agent runs as a read-only explorer, told to plan only.
    assert.equal(byTitle['Plan the change'].kind, 'explore');
    assert.match(byTitle['Plan the change'].instruction, /^Plan only: [\s\S]*Find the code involved/);
    assert.equal(await node('Plan the change').locator('[data-status]').getAttribute('data-status'), 'succeeded');
    await canvas.getByText(/2 of 5 done/).waitFor({ timeout: 8000 });
    // A live wire streams its chevrons: the finished explorer feeds running builders.
    assert.ok(await canvas.locator('.canvas-chevron[data-live]').count() > 0, 'live wires stream');
    assert.equal(ran.maxConcurrency, 3);

    // The command bar, typed AutoCAD-style: Ctrl+A over the board, then how many, the kind and the model in one line.
    // Without typed tasks, Enter asks for them, one per line.
    const adder = canvas.getByRole('dialog', { name: 'Add agents', exact: true }), command = adder.getByRole('textbox', { name: 'Command', exact: true });
    const plan = adder.getByLabel('Will add');
    const board = await canvas.locator('.react-flow__pane').boundingBox();
    const agentsNamed = async () => { await page.waitForTimeout(400); return (await saved()).nodes.filter(item => item.type === 'agent'); };
    await page.mouse.click(board.x + 60, board.y + board.height - 140);
    await page.keyboard.press('Control+a');
    await command.waitFor();
    await page.keyboard.type('3imp luna');
    assert.equal(await plan.innerText(), '3 × Implement\nLuna 6 · OpenAI');
    await page.keyboard.press('Enter');
    await adder.getByRole('textbox', { name: 'Tasks, one per line' }).waitFor();
    await page.keyboard.type('Fix the parser'); await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Fix the lexer');
    await adder.getByText('3 agents: 2 with a task, 1 still to write').waitFor();
    await page.keyboard.press('Enter');
    await adder.waitFor({ state: 'hidden' });
    await until('three agents were added', () => document.querySelectorAll('.react-flow__node-agent').length === 8);
    const added = (await agentsNamed()).filter(item => item.data.kind === 'implement' && item.data.model === 'gpt-6-luna');
    assert.deepEqual(added.map(item => [item.data.title, item.data.instruction, item.data.provider]), [['Fix the parser', 'Fix the parser', null], ['Fix the lexer', 'Fix the lexer', null], ['New Implement agent 3', '', null]]);

    // Ctrl+A in a text field selects its text and opens nothing; Escape closes the bar; a double-click opens it.
    await node('Fix the parser').click();
    await inspector.getByRole('textbox', { name: 'Instruction', exact: true }).focus();
    await page.keyboard.press('Control+a');
    assert.equal(await adder.count(), 0);
    assert.equal(await page.evaluate(() => document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)), 'Fix the parser');
    await page.mouse.dblclick(board.x + 60, board.y + 60);
    await command.waitFor(); await page.keyboard.press('Escape'); await adder.waitFor({ state: 'hidden' });

    // Counts are typed, and only what Elpis allows is taken, with the reason when it is not.
    const maxField = canvas.getByRole('textbox', { name: 'Max agents', exact: true }), atOnce = canvas.getByRole('textbox', { name: 'At once', exact: true });
    await maxField.fill('300');
    await canvas.getByText('Elpis runs at most 256 agents in one graph.').waitFor();
    await maxField.fill('5');
    await canvas.getByText('The graph already has 8 agents; remove some first.').waitFor();
    await maxField.fill('12'); await maxField.blur();
    await page.waitForTimeout(400);
    assert.equal((await saved()).maxAgents, 12);
    await atOnce.fill('6');
    await canvas.getByText('Elpis allows 4 at once here (agents.max_threads).').waitFor();
    await atOnce.fill('4'); await atOnce.blur();
    assert.equal(await atOnce.inputValue(), '4');

    // Browsing by keyboard: Tab on the board opens the bar; with one provider its models are listed; → opens a model's
    // thinking levels; Enter takes one, and Enter again adds once the command is complete.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Tab');
    await command.waitFor();
    await page.keyboard.type('2 ver');
    assert.deepEqual(await adder.getByRole('listbox', { name: 'Models' }).getByRole('option').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Default model', 'Luna 6', 'Sol 6.1']);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight');
    assert.deepEqual(await adder.getByRole('listbox', { name: 'Thinking levels' }).getByRole('option').allInnerTexts().then(list => list.map(item => item.split('\n')[0])), ['Low thinking', 'Medium thinking', 'High thinking']);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    assert.equal(await command.inputValue(), '2 ver gpt-6.1-sol high ');
    await page.keyboard.press('Enter');
    await adder.getByRole('textbox', { name: 'Tasks, one per line' }).waitFor();
    await page.keyboard.press('Enter');
    await until('two verifiers were added', () => document.querySelectorAll('.react-flow__node-agent').length === 10);
    const verifiers = (await agentsNamed()).filter(item => item.data.kind === 'verify' && item.data.model === 'gpt-6.1-sol');
    assert.deepEqual(verifiers.map(item => [item.data.effort, item.data.instruction]), [['high', ''], ['high', '']]);

    // A click on an agent's dot opens the bar there; tasks typed after a colon skip the tasks step, and the new agent
    // waits for the agent whose dot it was. Words the bar can't place are listed, never guessed.
    const suiteDot = await node('Run the suite').locator('.react-flow__handle.source').boundingBox();
    await page.mouse.click(suiteDot.x + suiteDot.width / 2, suiteDot.y + suiteDot.height / 2);
    await command.waitFor();
    await page.keyboard.type('fix luna zzz');
    await adder.getByText('Not understood: zzz').waitFor();
    for (let index = 0; index < 4; index++) await page.keyboard.press('Backspace');
    await page.keyboard.type(': Patch what the suite found; Patch the docs');
    await page.keyboard.press('Enter');
    await until('the dot added two agents', () => document.querySelectorAll('.react-flow__node-agent').length === 12);
    await page.waitForTimeout(400);
    const graph = await saved(), suite = graph.nodes.find(item => item.data?.title === 'Run the suite');
    const patches = graph.nodes.filter(item => item.data?.title?.startsWith('Patch'));
    assert.deepEqual(patches.map(item => item.data.title), ['Patch what the suite found', 'Patch the docs']);
    assert.ok(patches.every(patch => graph.edges.some(edge => edge.source === suite.id && edge.target === patch.id)), 'both wait for Run the suite');

    // A wire let go on empty board opens the bar too; the graph is now at its limit, so the bar says so.
    const handle = await node('Run the suite').locator('.react-flow__handle.source').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + 120, handle.y + 160, { steps: 6 }); await page.mouse.up();
    await adder.getByText('No room for more agents').waitFor();
    await page.keyboard.press('Escape');
    await canvas.getByRole('button', { name: 'Add Explore agent', exact: true }).click();
    await canvas.getByText('The graph is at its limit of 12 agents. Raise Max agents to add more.').waitFor();

    // An agent's dashboard (double-click, or Enter on the selected agent): its wiring and, once it runs, its live work.
    await node('Plan the change').dblclick();
    const dash = canvas.getByRole('dialog', { name: 'Plan the change dashboard' });
    await dash.getByText('Plan: change lexer.rs first, then parser.rs.').waitFor();
    assert.match(await dash.innerText(), /Worked for 1m 4s · Ran a command/);
    assert.match(await dash.innerText(), /Feeds\s+Build part one, Build part two/);
    await page.keyboard.press('Escape'); await dash.waitFor({ state: 'hidden' });
    await node('Run the suite').click(); await page.keyboard.press('Enter');
    await canvas.getByRole('dialog', { name: 'Run the suite dashboard' }).getByText('Not started. What it does shows here once the graph runs.').waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
