// The agents canvas's isometric view (components/agents-iso.tsx), as Deus Ex's hacking screen: every agent a pedestal
// to click, select and open, the run's state on it and its wires, kept inside the window, and no orange in the light
// theme. Synthetic HTTP fixture, as tests/canvas.test.cjs. Screenshots go to $ELPIS_SHOTS when it is set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const { chooseOption, oranges, chooseTheme } = require('./controls.cjs');
const shots = process.env.ELPIS_SHOTS;

test('agents canvas, isometric: agents as buttons to select and open, run state, inside the window, no orange in light', async () => {
  const root = { id: 'root', name: 'Canvas run', cwd: '/tmp/demo', model: 'sol', modelProvider: 'openai', status: { type: 'idle' }, desktopAccess: { writable: true, mode: 'direct' } };
  let polls = 0, ran = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local'); let raw = ''; for await (const chunk of req) raw += chunk;
    const json = value => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
    if (url.pathname === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('event: connection\ndata: {"connected":true}\n\n'); return; }
    if (url.pathname === '/api/health') return json({ connected: true });
    if (url.pathname === '/api/models') return json({ data: [{ id: 'luna', model: 'gpt-6-luna', displayName: 'Luna 6' }, { id: 'sol', model: 'gpt-6.1-sol', displayName: 'Sol 6.1' }], nextCursor: null });
    if (url.pathname === '/api/settings') return json({ main: { model: 'gpt-6.1-sol', provider: 'openai' }, background: {}, smartPrune: { enabled: false, explicitOverride: {} }, memory: {}, write: { available: false, reason: '' }, agents: { graph: 256, atOnce: 4, source: 'agents.max_threads' } });
    if (url.pathname === '/api/folders') return json({ data: ['docs', 'src', 'src/lib', 'tests'] });
    if (url.pathname === '/api/threads' && req.method === 'POST') return json({ thread: root });
    if (url.pathname === '/api/threads') return json({ data: [], nextCursor: null });
    if (url.pathname === '/api/workflows/run') { ran = JSON.parse(raw); return json({ graphId: 'g1', threadId: 'root', turnId: 't1' }); }
    if (url.pathname === '/api/workflows') {
      polls++;
      if (!ran) return json({ data: [] });
      // The first writer is done and its check runs, then passes; everything after it runs.
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
    await page.addInitScript(() => { if (!localStorage.getItem('elpis-projects-v1')) localStorage.setItem('elpis-projects-v1', JSON.stringify({ projects: [{ id: 'p1', name: 'demo', cwd: '/tmp/demo' }], selectedId: 'p1' })); });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true }); await canvas.waitFor();
    const until = async (label, condition, timeout) => { try { await page.waitForFunction(condition, null, timeout ? { timeout } : undefined); } catch (error) { throw Error(`${label}: ${error.message.split('\n')[0]}`); } };
    const shoot = async name => { if (shots) { await fs.mkdir(shots, { recursive: true }); await page.waitForTimeout(400); await page.screenshot({ path: path.join(shots, `${name}.png`) }); } };

    // The header switches the board between Flat (editing) and Isometric (watching and clicking).
    const view = canvas.getByRole('group', { name: 'Workflows view', exact: true });
    const flat = view.getByRole('button', { name: 'Flat', exact: true }), iso = view.getByRole('button', { name: 'Isometric', exact: true });
    assert.deepEqual([await flat.getAttribute('aria-pressed'), await iso.getAttribute('aria-pressed')], ['true', 'false']);
    await iso.click();
    assert.equal(await iso.getAttribute('aria-pressed'), 'true');
    const board = canvas.getByRole('region', { name: 'Isometric board', exact: true }); await board.waitFor();
    assert.equal(await canvas.locator('.react-flow').count(), 0, 'the isometric view takes the flat board\'s place');

    // Every agent, and the Mother, is a button named for it and its state, with its title upright above it.
    const titles = ['Quillon · Part 1', 'Veyra · Part 2', 'Orilo · Part 3', 'Nuvani · Join the parts'];
    const agent = title => board.getByRole('button', { name: new RegExp(`^${title}:`) });
    for (const title of titles) assert.equal(await agent(title).count(), 1, `${title} is a button`);
    assert.equal(await agent('Quillon · Part 1').getAttribute('aria-label'), 'Quillon · Part 1: wave 1, not run, checked after it runs');
    assert.equal(await agent('Nuvani · Join the parts').getAttribute('aria-label'), 'Nuvani · Join the parts: wave 2, not run, checked after it runs');
    assert.equal(await board.getByRole('button', { name: /^Mother:/ }).count(), 1);
    const labels = await board.locator('.iso-label').evaluateAll(list => list.map(item => ({ text: item.textContent, size: parseFloat(getComputedStyle(item).fontSize), transform: getComputedStyle(item).transform })));
    assert.deepEqual(labels.map(item => item.text).sort(), ['1Quillon · Part 1', '1Veyra · Part 2', '1Orilo · Part 3', '2Nuvani · Join the parts', 'Mother'].sort(), 'each title, with its wave as a badge');
    for (const label of labels) {
      assert.ok(label.size >= 12, `${label.text} is at least 12px (${label.size})`);
      // Centred with a translate only: no rotation, skew or scale.
      assert.match(label.transform, /^matrix\(1, 0, 0, 1, /, `${label.text} is upright (${label.transform})`);
    }

    // A click selects (the side panel shows the agent), Shift+click adds, a click on the empty board clears.
    await agent('Veyra · Part 2').click();
    const inspector = canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    assert.equal(await inspector.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Veyra · Part 2');
    assert.equal(await agent('Veyra · Part 2').getAttribute('aria-pressed'), 'true');
    await agent('Orilo · Part 3').click({ modifiers: ['Shift'] });
    await canvas.getByRole('complementary', { name: 'Selected agents', exact: true }).getByText(/^2 agents selected$/i).waitFor();
    const empty = await board.boundingBox();
    await page.mouse.click(empty.x + 8, empty.y + 8);
    await canvas.getByRole('complementary', { name: 'Architectures', exact: true }).waitFor();
    // The Mother opens her panel.
    await board.getByRole('button', { name: /^Mother:/ }).click();
    await canvas.getByRole('complementary', { name: 'Mother', exact: true }).waitFor();

    // Enter opens the dashboard; double-click now opens the inline name editor.
    await agent('Quillon · Part 1').click(); await page.keyboard.press('Enter');
    const dashboard = canvas.getByRole('dialog', { name: 'Quillon · Part 1 info', exact: true }); await dashboard.waitFor();
    await page.keyboard.press('Escape'); await dashboard.waitFor({ state: 'detached' });
    await agent('Nuvani · Join the parts').dblclick();
    await canvas.getByRole('textbox', { name: 'Rename agent', exact: true }).waitFor();
    await page.keyboard.press('Escape'); await agent('Nuvani · Join the parts').click(); await page.keyboard.press('Enter');
    await canvas.getByRole('dialog', { name: 'Nuvani · Join the parts info', exact: true }).getByRole('button', { name: 'Close info' }).click();

    // Keys: Tab reaches the board; the arrows move between agents in run order.
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.split(':')[0] ?? document.activeElement?.tagName);
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).focus();
    await page.keyboard.press('Tab');
    assert.ok(await board.evaluate(element => element.contains(document.activeElement) && document.activeElement.getAttribute('role') === 'button'), 'Tab reaches an agent on the board');
    await agent('Quillon · Part 1').focus();
    const walked = [];
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowUp', 'ArrowUp']) { await page.keyboard.press(key); walked.push(await focused()); }
    assert.deepEqual(walked, ['Veyra · Part 2', 'Orilo · Part 3', 'Nuvani · Join the parts', 'Orilo · Part 3', 'Veyra · Part 2', 'Quillon · Part 1', 'Mother']);
    // Space opens patterns without changing the current selection.
    const selectedBefore = await inspector.getByRole('textbox', { name: 'Name', exact: true }).inputValue();
    await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space');
    await canvas.getByRole('textbox', { name: 'Workflow pattern', exact: true }).press('Escape');
    assert.equal(await inspector.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), selectedBefore);

    // Hovering an agent lights it and its wires, and the status panel names it.
    await agent('Nuvani · Join the parts').hover();
    const status = board.getByRole('region', { name: 'Agent status', exact: true });
    assert.match(await status.innerText(), /Nuvani · Join the parts[\s\S]*Wave 2/);
    assert.equal(await board.locator('.iso-link[data-hot]').count(), 3, 'the three wires into Nuvani · Join the parts light up');

    // The wheel zooms, a drag pans, Fit shows the whole graph again.
    const world = board.locator('.iso-world');
    const fitted = await world.getAttribute('transform');
    const middle = await board.boundingBox();
    await page.mouse.move(middle.x + 20, middle.y + 20); await page.keyboard.down('Control'); await page.mouse.wheel(0, -400); await page.keyboard.up('Control'); await page.waitForTimeout(100);
    assert.notEqual(await world.getAttribute('transform'), fitted, 'modifier wheel zooms');
    const zoomed = await world.getAttribute('transform');
    await page.mouse.move(middle.x + 14, middle.y + 14); await page.mouse.down(); await page.mouse.move(middle.x + 90, middle.y + 60, { steps: 5 }); await page.mouse.up();
    assert.notEqual(await world.getAttribute('transform'), zoomed, 'a drag pans');
    await board.getByRole('button', { name: 'Fit view', exact: true }).click();
    assert.equal(await world.getAttribute('transform'), fitted, 'Fit shows the whole graph again');

    // Nothing leaves the window or the board, and the controls never cover an agent or each other, in Masih's window
    // and a large one.
    for (const [width, height] of [[1130, 660], [1440, 900]]) {
      await page.setViewportSize({ width, height }); await page.waitForTimeout(300);
      const report = await page.evaluate(() => {
        const box = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }; };
        const name = element => element.getAttribute('aria-label') ?? element.textContent.trim().slice(0, 40);
        const area = box(document.querySelector('.iso-board'));
        const inside = (outer, inner) => inner.left >= outer.left - 0.5 && inner.top >= outer.top - 0.5 && inner.right <= outer.right + 0.5 && inner.bottom <= outer.bottom + 0.5;
        const window_ = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        const meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        const agents = [...document.querySelectorAll('.iso-node')], labels = [...document.querySelectorAll('.iso-label')], hud = [...document.querySelectorAll('.iso-hud')];
        const header = [...document.querySelectorAll('.canvas-header button, .canvas-header input')];
        return {
          outsideBoard: [...agents, ...labels, ...hud].filter(element => !inside(area, box(element))).map(name),
          outsideWindow: [...header, ...hud.flatMap(element => [element, ...element.querySelectorAll('button')])].filter(element => !inside(window_, box(element))).map(name),
          covered: hud.flatMap(panel => [...agents, ...labels].filter(element => meet(box(panel), box(element))).map(element => `${name(panel)} covers ${name(element)}`)),
          hudOverlap: hud.length === 2 && meet(box(hud[0]), box(hud[1])),
          labelsOverlap: labels.flatMap((a, index) => labels.slice(index + 1).filter(b => meet(box(a), box(b))).map(b => `${a.textContent} / ${b.textContent}`)),
        };
      });
      assert.deepEqual(report.labelsOverlap, [], `titles overlap at ${width}×${height}`);
      assert.deepEqual(report.outsideBoard, [], `outside the board at ${width}×${height}`);
      assert.deepEqual(report.outsideWindow, [], `outside the window at ${width}×${height}`);
      assert.deepEqual(report.covered, [], `the controls cover the graph at ${width}×${height}`);
      assert.equal(report.hudOverlap, false, `the controls and the status panel overlap at ${width}×${height}`);
    }

    // A run: each agent's pedestal, check ring and wires show its state, and its button says it.
    for (const [index, title] of titles.entries()) await agent(title).click(index ? { modifiers: ['Shift'] } : undefined);
    const group = canvas.getByRole('complementary', { name: 'Selected agents', exact: true });
    await group.getByText(/^4 agents selected$/i).waitFor();
    await chooseOption(group.getByRole('combobox', { name: 'Add a folder', exact: true }), 'src/lib');
    await group.getByRole('button', { name: 'Done', exact: true }).click();
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await until('Quillon · Part 1 is done and its check passed', () => document.querySelector('.iso-node[aria-label^="Quillon · Part 1:"]')?.getAttribute('aria-label') === 'Quillon · Part 1: wave 1, done, check passed', 8000);
    assert.equal(await agent('Nuvani · Join the parts').getAttribute('aria-label'), 'Nuvani · Join the parts: wave 2, running, being checked');
    assert.equal(await agent('Quillon · Part 1').getAttribute('data-status'), 'succeeded');
    assert.equal(await board.locator('.iso-ring[data-check="succeeded"]').count(), 1);
    assert.match(await board.getByRole('button', { name: /^Mother:/ }).getAttribute('aria-label'), /running$/);
    // Quillon · Part 1's checked work feeds the running joiner: that wire is live and its chevrons stream.
    assert.equal(await board.locator('.iso-link[data-state="live"]:not([data-mother])').count(), 1);
    assert.ok(await board.locator('.iso-link[data-state="live"] .iso-chevron[data-live]').count() >= 3, 'live wires stream their chevrons');

    // The light interface keeps its theme palette; agent identities have their own colors.
    await page.setViewportSize({ width: 1130, height: 660 }); await page.waitForTimeout(300);
    await agent('Veyra · Part 2').hover();
    assert.deepEqual(await oranges(page, '.iso-node[data-kind="agent"], .iso-port[data-kind="agent"]'), [], 'light theme controls: no orange');
    await shoot('iso-light-1130');
    await chooseTheme(page, 'dark'); await page.waitForTimeout(300);
    await agent('Veyra · Part 2').hover();
    await shoot('iso-dark-1130');
    await chooseTheme(page, 'light');

    // Loading an architecture redraws the board in its run order; Flat brings the editor back.
    await canvas.getByRole('button', { name: /Hierarchical/ }).click();
    await agent('Lumaro · Team B worker 2').waitFor();
    assert.equal(await board.locator('.iso-node[data-kind="agent"]').count(), 8);
    assert.equal(await agent('Eshvi · Join the areas').getAttribute('aria-label'), 'Eshvi · Join the areas: wave 4, not run, checked after it runs');
    // Dense in Masih's window: no title covers another; a title without room shows its wave badge until pointed at.
    const overlapping = () => board.locator('.iso-label').evaluateAll(list => { const box = item => item.getBoundingClientRect(), meet = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
      return list.flatMap((a, index) => list.slice(index + 1).filter(b => meet(box(a), box(b))).map(b => `${a.textContent} / ${b.textContent}`)); });
    assert.deepEqual(await overlapping(), [], 'dense graph: no title covers another');
    const short = await board.locator('.iso-label[data-short]').evaluateAll(list => list.map(item => item.dataset.for));
    await shoot('iso-light-hierarchical-1130');
    if (short.length) {
      const id = short[0], title = (await board.locator(`.iso-node[data-id="${id}"]`).getAttribute('aria-label')).replace(/: wave \d+, .*$/, '');
      await board.locator(`.iso-node[data-id="${id}"]`).hover();
      assert.match(await board.locator(`.iso-label[data-for="${id}"]`).innerText(), new RegExp(`\\n${title}$`), 'pointed at, a badge shows its full title');
      await shoot('iso-light-hierarchical-hover-1130');
    }
    await flat.click();
    await canvas.locator('.react-flow__node-agent').first().waitFor();
    assert.equal(await board.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); server.close(); }
});
