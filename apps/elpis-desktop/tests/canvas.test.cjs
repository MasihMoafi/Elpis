// The agents canvas: ready-made architectures, agents as nodes wired by dependency, loops refused, the graph kept
// on this device, and a run that sends Elpis's work graph and shows each agent's state live. Synthetic HTTP fixture.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

test('agents canvas: architecture, add and wire agents, refuse loops, persist, run and follow it live', async () => {
  const root = { id: 'root', name: 'Canvas run', cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  const posts = []; let polls = 0, ran = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname !== '/api/session') posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : null });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }, { id: 'sol', model: 'gpt-6.1-sol', displayName: 'Sol 6.1' }], nextCursor: null });
    if (url.pathname === '/api/threads' && req.method === 'POST') return json({ thread: root });
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/workflows/run') { ran = JSON.parse(raw); return json({ graphId: 'g1', threadId: 'root', turnId: 't1' }); }
    if (url.pathname === '/api/workflows') {
      polls++;
      if (!ran) return json({ data: [] });
      const state = id => ({ [ran.tasks[0].id]: 'succeeded', [ran.tasks[1].id]: polls > 1 ? 'succeeded' : 'running' }[id] ?? (polls > 1 ? 'running' : 'pending'));
      return json({ data: [{ id: 'g1', name: ran.name, status: 'running', maxConcurrency: 3, error: null, eventCount: 3, tasks: ran.tasks.map(task => ({ id: task.id, kind: task.kind, title: task.title, status: state(task.id), dependencies: task.dependsOn, assignedThreadId: null, provider: null, model: null, result: null, evidence: [], failureReason: null })) }] });
    }
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
    const nodes = canvas.locator('.react-flow__node'), edges = canvas.locator('.react-flow__edge');
    const node = title => canvas.locator('.react-flow__node').filter({ hasText: title });
    // Each wait names itself, so a failure says which step broke.
    const until = async (label, condition, timeout) => { try { await page.waitForFunction(condition, null, timeout ? { timeout } : undefined); } catch (error) { throw Error(`${label}: ${error.message.split('\n')[0]}`); } };

    // A ready-made architecture fills the canvas: one explorer, two builders, a verifier.
    await canvas.getByRole('button', { name: /Plan → Build → Verify/ }).click();
    await until('the architecture has 4 agents', () => document.querySelectorAll('.react-flow__node').length === 4);
    assert.equal(await edges.count(), 4);
    assert.deepEqual(await nodes.evaluateAll(list => list.map(item => item.querySelector('[data-kind]')?.dataset.kind).sort()), ['explore', 'implement', 'implement', 'verify']);

    // Selecting an agent opens it for editing.
    await node('Run the suite').click();
    const inspector = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    await inspector.getByRole('textbox', { name: 'Instruction', exact: true }).fill('Run every test and show the output.');

    // Add a Fix agent and wire the verifier to it by dragging between their handles.
    await canvas.getByRole('button', { name: 'Add Fix agent', exact: true }).click();
    await until('the Fix agent is added', () => document.querySelectorAll('.react-flow__node').length === 5);
    const drag = async (from, to) => {
      const a = await node(from).locator('.react-flow__handle.source').boundingBox(), b = await node(to).locator('.react-flow__handle.target').boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 }); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 5 }); await page.mouse.up();
    };
    await drag('Run the suite', 'New Fix agent');
    await until('the drag made a wire', () => document.querySelectorAll('.react-flow__edge').length === 5);

    // A wire that would make a loop is refused, and says why.
    await drag('New Fix agent', 'Map the code');
    await canvas.getByText('That wire would make a loop', { exact: false }).waitFor();
    assert.equal(await edges.count(), 5);

    // The graph is kept on this device.
    await page.waitForTimeout(600); await page.reload();
    await page.getByRole('button', { name: 'Canvas', exact: true }).click(); await canvas.waitFor();
    await until('the graph came back after a restart', () => document.querySelectorAll('.react-flow__node').length === 5 && document.querySelectorAll('.react-flow__edge').length === 5);

    // An agent without an instruction stops the run before anything is sent, and says which one.
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await canvas.getByText('“New Fix agent” needs an instruction.').waitFor();
    assert.equal(ran, null);
    await node('New Fix agent').click();
    await inspector.getByRole('textbox', { name: 'Instruction', exact: true }).fill('Repair whatever the suite found.');

    // Run: a new chat holds the run; Elpis gets every agent with its dependencies.
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await until('an agent shows as running', () => document.querySelector('[data-status="running"]'));
    assert.equal(ran.rootThreadId, 'root');
    assert.equal(ran.tasks.length, 5);
    const byTitle = Object.fromEntries(ran.tasks.map(task => [task.title, task]));
    assert.deepEqual(byTitle['New Fix agent'].dependsOn, [byTitle['Run the suite'].id]);
    assert.equal(byTitle['Run the suite'].instruction, 'Run every test and show the output.');
    assert.equal(byTitle['Run the suite'].kind, 'verify');
    assert.equal(await node('Map the code').locator('[data-status]').getAttribute('data-status'), 'succeeded');
    await canvas.getByText(/2 of 5 done/).waitFor({ timeout: 8000 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
