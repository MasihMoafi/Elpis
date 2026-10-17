// The agents canvas's test fixture: a synthetic Elpis bridge over HTTP serving the built app (out/), a project open
// at /tmp/demo with its folders, two OpenAI models, and helpers to find agents and wires and read the saved graph.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');

/** A stand-in for Elpis's planner (POST /api/canvas/plan): a goal "from scratch" designs a two-agent team; one starting
 * with "Fix" adds an agent doing it; otherwise it fills each agent's empty prompt and folders. */
function planFor(body) {
  if (/from scratch/i.test(body.goal)) return { name: 'Dark theme', agents: [
    { key: 'a', title: 'Build the theme', prompt: 'Add the dark theme tokens.', folders: ['src'], doneWhen: ['The tokens exist'], waitsFor: [] },
    { key: 'b', title: 'Use the theme', prompt: 'Use the tokens on every page.', folders: ['src/lib'], doneWhen: ['Every page uses them'], waitsFor: ['a'] }] };
  const kept = body.agents.map(item => ({ ...item, prompt: item.prompt || `Do ${item.title}`, folders: item.folders.length ? item.folders : ['src'] }));
  return { name: '', agents: /^fix/i.test(body.goal) ? [...kept, { key: 'new', title: body.goal, prompt: body.goal, folders: ['src'], doneWhen: ['It works'], waitsFor: [] }] : kept };
}

/** `repository` is whether the project folder is a git repository (GET /api/repository); `graph` is a board saved on the
 * device before the page opens; `listed(run, looks)` answers a look at the run (workGraph/list) instead of the default,
 * which runs for one look and then succeeds. */
async function openCanvas({ width = 1440, height = 900, repository = false, graph = null, listed = null } = {}) {
  const posts = [], plans = [], runs = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (req.method === 'POST' && url.pathname !== '/api/session') posts.push({ path: url.pathname, body: raw ? JSON.parse(raw) : null });
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }, { id: 'sol', model: 'gpt-6.1-sol', displayName: 'Sol 6.1', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'low' }], nextCursor: null });
    if (url.pathname === '/api/settings') return json({ main: { model: 'gpt-6.1-sol', provider: 'openai' }, background: {}, smartPrune: { enabled: false, explicitOverride: {} }, memory: {}, write: { available: false, reason: '' }, agents: { graph: 256, atOnce: 4, source: 'agents.max_threads' } });
    if (url.pathname === '/api/folders') return json({ data: ['docs', 'src', 'src/lib', 'tests'] });
    if (url.pathname === '/api/repository') return json({ repository });
    if (url.pathname === '/api/canvas/plan') { const body = JSON.parse(raw); plans.push(body); return json(planFor(body)); }
    // Runs: each chat started gets an id; a graph run on it finishes after its first look.
    if (url.pathname === '/api/threads' && req.method === 'POST') { const id = `chat-${posts.filter(post => post.path === '/api/threads').length}`; return json({ thread: { id, name: JSON.parse(raw).name, cwd: '/tmp/demo', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } } }); }
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/workflows/run') { const body = JSON.parse(raw); runs.push({ ...body, graphId: `graph-${runs.length + 1}`, looks: 0 }); return json({ graphId: `graph-${runs.length}`, threadId: body.rootThreadId, turnId: 't' }); }
    if (url.pathname === '/api/workflows') {
      const mine = runs.filter(item => item.rootThreadId === url.searchParams.get('threadId'));
      return json({ data: mine.map(item => { const looks = item.looks++, status = looks ? 'succeeded' : 'running'; return listed?.(item, looks) ?? { id: item.graphId, name: item.name, status, tasks: item.tasks.map(task => ({ id: task.id, status, assignedThreadId: null })) }; }) });
    }
    if (url.pathname.startsWith('/api/')) return json({});
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try { const content = await fs.readFile(path.join(__dirname, '../out', relative)); res.setHeader('content-type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(content); }
    catch { res.statusCode = 404; res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.ELPIS_CHROMIUM || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width, height } }); page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(saved => {
    if (!localStorage.getItem('elpis-projects-v1')) localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'p1', name: 'demo', cwd: '/tmp/demo' }], selectedId: 'p1' }));
    if (saved && !localStorage.getItem('elpis-workflow-draft-v1')) localStorage.setItem('elpis-workflow-draft-v1', JSON.stringify(saved));
  }, graph);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  const canvas = page.getByRole('region', { name: 'Agents canvas', exact: true }); await canvas.waitFor();
  const node = title => canvas.locator('.react-flow__node').filter({ hasText: title });
  return {
    page, canvas, posts, plans, runs, errors, node,
    agents: canvas.locator('.react-flow__node-agent'),
    wires: canvas.locator('.react-flow__edge:not(.canvas-edge-mother)'),
    /** The graph as saved on this device, after the save's short wait. */
    saved: async () => { await page.waitForTimeout(400); return page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1'))); },
    titles: () => canvas.locator('.react-flow__node-agent .agent-node-title').allInnerTexts(),
    /** Waits for the board to hold `count` agents, naming the step on failure. */
    agentCount: async (count, label) => { try { await page.waitForFunction(n => document.querySelectorAll('.react-flow__node-agent').length === n, count); } catch (error) { throw Error(`${label}: expected ${count} agents, ${error.message.split('\n')[0]}`); } },
    fit: async () => { await canvas.getByRole('button', { name: /fit view/i }).click(); await page.waitForTimeout(400); },
    close: async () => { await browser.close(); server.close(); },
  };
}

module.exports = { openCanvas, planFor };
