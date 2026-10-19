const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption, chooseTheme } = require('./controls.cjs');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');

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
      const boxes = await nav.getByRole('button').evaluateAll(buttons => buttons.map(button => {
        const icon = button.querySelector('svg'), box = icon.getBoundingClientRect(), row = button.getBoundingClientRect();
        return { x: box.x, width: box.width, height: box.height, offset: box.y - row.y, paint: icon.getAttribute('fill') === 'currentColor' || icon.getAttribute('stroke') === 'currentColor' };
      }));
      assert.ok(boxes.every(box => box.paint));
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
  const f = await openCanvas({ desktop: true });
  let request;
  await f.page.route('**/api/experiment-lab', route => {
    if (route.request().method() === 'POST') request = route.request().postDataJSON();
    return route.fulfill({ json: { record: null } });
  });
  try {
    await f.agents.first().click();
    await f.canvas.getByRole('textbox', { name: 'Prompt', exact: true }).fill('Fresh board instruction for the Lab');
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

test('every starter opens its Sources in the side panel without replacing the board, including the unproven blank', async () => {
  const f = await openCanvas();
  try {
    const before = await f.saved();
    const sources = f.canvas.getByRole('link', { name: /^Sources for / });
    assert.equal(await sources.count(), 10);
    for (let index = 0; index < 10; index++) {
      if (index === 4) { await sources.nth(index).focus(); await f.page.keyboard.press('Enter'); }
      else await sources.nth(index).click();
      const panel = f.canvas.getByRole('complementary', { name: 'Workflow sources', exact: true });
      await panel.getByText('What is proven', { exact: true }).waitFor();
      await panel.getByText('What is not', { exact: true }).waitFor();
      assert.match(await panel.innerText(), /unproven|not validated|No direct evidence/i);
      if (index === 4) {
        assert.match(await panel.innerText(), /74.4/);
        assert.equal(await panel.getByRole('link', { name: /Self-Consistency/ }).getAttribute('href'), 'https://arxiv.org/abs/2203.11171');
      }
      await panel.getByRole('button', { name: 'Back to patterns', exact: true }).click();
    }
    assert.deepEqual(await f.saved(), before);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Lab runs the declared repeated comparison, restores evidence, exports, shows failures and stops a run', async () => {
  const f = await openCanvas({ desktop: true });
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
    assert.equal(requests[0].repetitions, 2); assert.equal(requests[0].pattern, 'voting');
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

test('Sources and Lab stay readable in light/dark at Masih’s window size', async () => {
  const f = await openCanvas({ width: 1130, height: 660 });
  await f.page.route('**/api/experiment-lab', route => route.fulfill({ json: { record: null } }));
  try {
    await fs.mkdir('/tmp/elpis-provenance-screens', { recursive: true });
    for (const theme of ['light', 'dark']) {
      if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(f.page, theme);
      await f.canvas.getByRole('link', { name: 'Sources for Voting', exact: true }).click();
      await f.page.screenshot({ path: `/tmp/elpis-provenance-screens/sources-${theme}.png` });
      await f.canvas.getByRole('button', { name: 'Back to patterns', exact: true }).click();
      await f.page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Lab', exact: true }).click();
      const lab = f.page.getByRole('region', { name: 'Lab', exact: true });
      assert.equal(await lab.evaluate(el => el.scrollWidth <= el.clientWidth), true);
      await f.page.screenshot({ path: `/tmp/elpis-provenance-screens/lab-${theme}.png` });
      await f.page.getByRole('button', { name: 'Workflows', exact: true }).click();
    }
  } finally { await f.close(); }
});
