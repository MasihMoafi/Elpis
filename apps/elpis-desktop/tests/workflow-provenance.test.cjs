const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chooseOption, chooseTheme } = require('./controls.cjs');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');

// Lab regressions share the standard fixture; its current-board input is now a pet team.
async function openTeam(options = {}) {
  const f = await fixture({ ...options, storage: { 'elpis-workflow-draft-v1': JSON.stringify({ name: 'Team', nodes: [
    { id: 'pet-a', type: 'pet', position: { x: 100, y: 100 }, data: { character: 'researcher', title: 'Researcher', instruction: 'Research the task.', model: null, editsFiles: false } },
  ], edges: [] }) } });
  await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
  f.canvas = f.page.getByRole('region', { name: 'Workflows', exact: true });
  f.agents = f.canvas.locator('.react-flow__node-pet');
  f.saved = () => f.page.evaluate(() => JSON.parse(localStorage.getItem('elpis-workflow-draft-v1')));
  return f;
}


test('Lab is the page after New chat, with history, command search and matching sidebar icons', async () => {
  const f = await fixture({ routes: { '/api/experiment-lab': () => ({ record: null }) } });
  try {
    const { page } = f, nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
    const names = await nav.getByRole('button').allTextContents();
    assert.deepEqual(names.slice(0, 3), ['New chat', 'Lab', 'Workflows']);
    const labButton = nav.getByRole('button', { name: 'Lab', exact: true });
    await labButton.focus(); await page.keyboard.press('Enter');
    const lab = page.getByRole('region', { name: 'Lab', exact: true });
    await lab.getByRole('heading', { name: 'Lab', exact: true }).waitFor();
    assert.equal(await labButton.getAttribute('aria-current'), 'page');
    assert.equal(await page.title(), 'Lab · Elpis');
    assert.equal(await page.getByRole('region', { name: 'Workflows', exact: true }).count(), 0);
    await nav.getByRole('button', { name: 'Workflows', exact: true }).click();
    const board = page.getByRole('region', { name: 'Workflows', exact: true });
    await board.waitFor();
    assert.equal(await board.getByRole('button', { name: 'Lab', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await lab.waitFor();
    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await board.waitFor();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search or start a chat' }).fill('Lab');
    await page.getByRole('option', { name: 'Lab', exact: true }).click();
    await lab.waitFor();
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await chooseTheme(page, theme);
      await page.waitForFunction(dark => document.documentElement.classList.contains('dark') === dark, theme === 'dark');
      const boxes = await nav.getByRole('button').evaluateAll((buttons, loveRed) => buttons.map(button => {
        const icon = button.querySelector('svg'), box = icon.getBoundingClientRect(), row = button.getBoundingClientRect();
        const paint = button.dataset.navPage === 'loveSpot'
          ? icon.getAttribute('fill') === 'var(--love-red)' && getComputedStyle(icon).fill === loveRed
          : icon.getAttribute('fill') === 'currentColor' || icon.getAttribute('stroke') === 'currentColor';
        return { x: box.x, width: box.width, height: box.height, offset: box.y - row.y, paint };
      }), theme === 'light' ? 'rgb(139, 16, 23)' : 'rgb(236, 87, 94)');
      assert.ok(boxes.every(box => box.paint), `${theme}: sidebar icons use currentColor and Love Spot uses its approved blood red (${JSON.stringify(boxes)})`);
      assert.deepEqual(boxes, boxes.map(() => boxes[0]), `${theme} sidebar icons align`);
      assert.equal(await lab.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      if (process.env.ELPIS_SHOTS) {
        await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
        // The wordmark inside an SVG image has its own arrival animation.
        await page.waitForTimeout(1000);
        await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/lab-${theme}.png`, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 760, height: 660 });
      assert.equal(await lab.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await lab.getByRole('button', { name: 'Run comparison', exact: true }).scrollIntoViewIfNeeded();
      if (process.env.ELPIS_SHOTS) await page.screenshot({ path: `${process.env.ELPIS_SHOTS}/lab-${theme}-narrow.png`, animations: 'disabled' });
      await page.setViewportSize({ width: 1130, height: 660 });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Lab receives the current board even when navigation immediately follows an edit', async () => {
  const f = await openTeam({ desktop: true });
  let request;
  await f.page.route('**/api/experiment-lab', route => {
    if (route.request().method() === 'POST') request = route.request().postDataJSON();
    return route.fulfill({ json: { record: null } });
  });
  try {
    await f.agents.first().click();
    await f.agents.first().getByRole('button', { name: 'Edit', exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Role prompt', exact: true }).fill('Fresh board instruction for the Lab');
    await f.page.keyboard.press('Escape');
    await f.page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Lab', exact: true }).click();
    const lab = f.page.getByRole('region', { name: 'Lab', exact: true });
    await chooseOption(lab.getByRole('combobox', { name: 'Pattern', exact: true }), 'current');
    await lab.getByRole('textbox', { name: 'Task', exact: true }).fill('Board handover');
    await lab.getByRole('textbox', { name: 'Expected answer', exact: true }).fill('42');
    const sent = f.page.waitForRequest(req => req.url().endsWith('/api/experiment-lab') && req.method() === 'POST');
    await lab.getByRole('button', { name: 'Run comparison', exact: true }).click();
    await sent;
    assert.ok(request.stages.some(stage => stage.instruction.includes('Fresh board instruction for the Lab')), JSON.stringify(request));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Lab runs the declared repeated comparison, restores evidence, exports, shows failures and stops a run', async () => {
  const f = await openTeam({ desktop: true });
  let current = null; const requests = [];
  await f.page.route('**/api/experiment-lab**', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      const data = req.postDataJSON(); requests.push(data);
      if (data.action === 'stop') current = { ...current, status: 'stopped' };
      else current = { id: 'fixture', status: 'completed', model: 'gpt-6-luna', request: data, trials: [
        ...Array.from({ length: data.repetitions }, (_, i) => ({ repetition: i + 1, arm: 'baseline', passed: false, elapsedMs: 1000, tokens: null, answer: '41', error: null, steps: [], endedAt: '2026-10-18T00:00:00Z' })),
        ...Array.from({ length: data.repetitions }, (_, i) => ({ repetition: i + 1, arm: 'pattern', passed: true, elapsedMs: 2500, tokens: 120, answer: '42', error: null, steps: [], endedAt: '2026-10-18T00:00:00Z' })),
      ] };
    }
    await route.fulfill({ json: { record: current } });
  });
  try {
    const boardBefore = await f.saved();
    await f.page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Lab', exact: true }).click();
    const lab = f.page.getByRole('region', { name: 'Lab', exact: true });
    await lab.getByRole('textbox', { name: 'Task', exact: true }).fill('What is 19 + 23? Return the number.');
    await lab.getByRole('textbox', { name: 'Expected answer', exact: true }).fill('42');
    await chooseOption(lab.getByRole('combobox', { name: 'Pattern', exact: true }), 'voting');
    const n = lab.getByRole('spinbutton', { name: 'Repetitions', exact: true });
    await n.fill('0'); assert.equal(await lab.getByRole('button', { name: 'Run comparison', exact: true }).isDisabled(), true);
    await n.fill('2'); await lab.getByRole('button', { name: 'Run comparison', exact: true }).click();
    await lab.getByRole('table', { name: 'Comparison', exact: true }).waitFor();
    const rows = lab.getByRole('row');
    assert.match(await rows.nth(1).innerText(), /0\/2[\s\S]*Unknown/);
    assert.match(await rows.nth(2).innerText(), /2\/2[\s\S]*120/);
    assert.equal(requests[0].repetitions, 2); assert.equal(requests[0].pattern, 'voting'); assert.equal(requests[0].stopWhen, 'count', 'fixed-count stays the default');
    assert.equal(requests[0].stages.filter(s => s.kind === 'implement').length, 4);
    await lab.getByText('Trial 1 · Single agent · Fail', { exact: true }).click();
    await lab.getByText('41', { exact: true }).first().waitFor();
    const download = f.page.waitForEvent('download');
    await lab.getByRole('button', { name: 'Export JSON', exact: true }).click();
    assert.equal((await download).suggestedFilename(), 'elpis-experiment-fixture.json');
    await f.page.reload();
    await f.page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Lab', exact: true }).click();
    await lab.getByRole('table', { name: 'Comparison', exact: true }).waitFor();
    current = { ...current, status: 'running' };
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await f.page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Lab', exact: true }).click();
    await lab.getByRole('button', { name: 'Stop experiment', exact: true }).click();
    await lab.getByRole('status').filter({ hasText: 'Stopped' }).waitFor();
    // The board is inactive while the Lab is open: its global selection/delete keys must not edit hidden agents.
    await lab.getByRole('heading', { name: 'Lab', exact: true }).click();
    await f.page.keyboard.press('Control+a'); await f.page.keyboard.press('Control+Delete');
    await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    assert.deepEqual(await f.saved(), boardBefore);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Lab offers “Until the task finishes”, sends and restores the choice, and says where the run stands and what is next', async () => {
  const f = await openTeam({ desktop: true, width: 1130, height: 660 });
  let current = null; const requests = [];
  const trial = (repetition, arm, passed) => ({ repetition, arm, passed, elapsedMs: 1000, tokens: 10, answer: passed ? '42' : '41', error: null, steps: [], endedAt: '2026-10-19T00:00:00Z' });
  await f.page.route('**/api/experiment-lab**', async route => {
    const req = route.request();
    if (req.method() === 'POST') {
      const data = req.postDataJSON(); requests.push(data);
      current = { id: 'until', status: 'completed', stopReason: 'solved', model: 'gpt-6-luna', request: data,
        trials: [trial(1, 'baseline', true), trial(1, 'pattern', false), trial(2, 'pattern', true), trial(2, 'baseline', true)] };
    }
    await route.fulfill({ json: { record: current } });
  });
  try {
    await fs.mkdir('/tmp/elpis-lab-ux-screens', { recursive: true });
    const open = async () => { await f.page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Lab', exact: true }).click(); return f.page.getByRole('region', { name: 'Lab', exact: true }); };
    const lab = await open();
    const repeat = lab.getByRole('radiogroup', { name: 'Repeat', exact: true });
    assert.equal(await repeat.getByRole('radio', { name: 'Fixed number', exact: true }).getAttribute('aria-checked'), 'true');
    await lab.getByRole('spinbutton', { name: 'Repetitions', exact: true }).waitFor();
    await repeat.getByRole('radio', { name: 'Until the task finishes', exact: true }).click();
    assert.equal(await repeat.getByRole('radio', { name: 'Until the task finishes', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await lab.getByRole('spinbutton', { name: 'Repetitions', exact: true }).count(), 0);
    assert.equal(await lab.getByRole('spinbutton').count(), 0, 'until it finishes asks for no number');
    assert.match(await lab.innerText(), /Stops when the pattern’s answer matches the expected answer; otherwise it stops after 10 repetitions/);
    await lab.getByRole('textbox', { name: 'Task', exact: true }).fill('What is 19 + 23?');
    await lab.getByRole('textbox', { name: 'Expected answer', exact: true }).fill('42');
    assert.match(await lab.innerText(), /Up to \d+ model calls/);
    await lab.getByRole('button', { name: 'Run comparison', exact: true }).click();
    await lab.getByRole('table', { name: 'Comparison', exact: true }).waitFor();
    assert.equal(requests[0].stopWhen, 'solved'); assert.equal(requests[0].repetitions, 10);
    assert.match(await lab.getByRole('status').innerText(), /Completed · Repetition 2 of up to 10 · 4 trials/);
    assert.match(await lab.innerText(), /Solved on repetition 2: the pattern’s answer matched/);
    assert.equal(await lab.getByRole('button', { name: 'New experiment', exact: true }).isEnabled(), true);
    assert.equal(await lab.getByRole('button', { name: 'Export JSON', exact: true }).isEnabled(), true);
    await f.page.reload();
    const again = await open();
    assert.equal(await again.getByRole('radio', { name: 'Until the task finishes', exact: true }).getAttribute('aria-checked'), 'true', 'the saved choice returns after a reload');
    assert.equal(await again.getByRole('spinbutton').count(), 0, 'the saved until-finished choice still asks for no number');
    for (const theme of ['light', 'dark']) for (const [width, height] of [[1130, 660], [400, 760]]) {
      await f.page.setViewportSize({ width: 1130, height: 660 });
      if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      await f.page.setViewportSize({ width, height });
      assert.equal(await again.evaluate(el => el.scrollWidth <= el.clientWidth), true, `no sideways scroll at ${width}px`);
      for (const radio of await again.getByRole('radio').all()) { const box = await radio.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.height >= 24, `radio fits at ${width}px`); }
      await f.page.screenshot({ path: `/tmp/elpis-lab-ux-screens/lab-${width}-${theme}.png` });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
