const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const shots = '/home/masih/.cache/elpis-tests/night-workflows';
const matrix = (page, selector) => page.locator(selector).evaluate(el => {
  const m = new DOMMatrix(getComputedStyle(el).transform);
  return { zoom: m.a, x: m.e, y: m.f };
});
for (const iso of [false, true]) test(`${iso ? 'isometric' : 'flat'}: scroll pans, modifier and pinch zoom at the pointer`, async () => {
  const f = await openCanvas();
  try {
    if (iso) await f.canvas.getByRole('button', { name: 'Isometric', exact: true }).click();
    const board = f.canvas.locator(iso ? '.iso-board' : '.react-flow__pane');
    const selector = iso ? '.iso-world' : '.react-flow__viewport';
    const box = await board.boundingBox();
    await f.page.mouse.move(box.x + 35, box.y + 35);
    await f.fit(); await f.page.mouse.move(box.x + 35, box.y + 35);
    const before = await matrix(f.page, selector);
    await f.page.mouse.wheel(75, 125); await f.page.waitForTimeout(300);
    const panned = await matrix(f.page, selector);
    assert.equal(panned.zoom, before.zoom, 'plain scroll must not zoom');
    assert.ok(panned.x !== before.x && panned.y !== before.y, 'two-finger deltas pan both axes');
    for (const modifier of ['Control', 'Meta']) {
      const old = await matrix(f.page, selector);
      await f.page.keyboard.down(modifier); await f.page.mouse.wheel(0, -150); await f.page.keyboard.up(modifier);
      await f.page.waitForTimeout(300);
      assert.ok((await matrix(f.page, selector)).zoom > old.zoom, `${modifier}+scroll zooms`);
    }
    // Chromium represents a trackpad pinch as a ctrl-modified wheel event.
    const old = await matrix(f.page, selector);
    await f.page.keyboard.down('Control'); await f.page.mouse.wheel(0, 100); await f.page.keyboard.up('Control');
    await f.page.waitForTimeout(300); assert.ok((await matrix(f.page, selector)).zoom < old.zoom);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Space opens the numbered command and Escape cancels it', async () => {
  const f = await openCanvas({ width: 900, height: 700 });
  try {
    await f.canvas.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await f.page.keyboard.press('Space');
    const command = f.canvas.getByRole('textbox', { name: 'Workflow pattern', exact: true });
    await command.waitFor();
    await command.fill('9'); await command.press('Enter');
    await f.canvas.getByText('Choose a pattern number from 1 to 5.', { exact: true }).waitFor();
    const box = await command.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 900 && box.y + box.height <= 700);
    await fs.mkdir(shots, { recursive: true }); await f.page.screenshot({ path: `${shots}/command-narrow.png` });
    await command.press('Escape'); assert.equal(await command.count(), 0);
  } finally { await f.close(); }
});
test('ordinary agents retain distinct identity colors in both views', async () => {
  const f = await openCanvas();
  try {
    for (const iso of [false, true]) {
      await f.canvas.getByRole('button', { name: iso ? 'Isometric' : 'Flat', exact: true }).click();
      const colors = await f.canvas.locator(iso ? '.iso-node[data-kind="agent"]' : '.agent-node[data-kind="agent"]').evaluateAll(nodes => nodes.map(n => getComputedStyle(n).getPropertyValue('--agent-color').trim()));
      assert.equal(new Set(colors).size, 4);
    }
  } finally { await f.close(); }
});

test('Space applies numbered patterns to characters, preserves editable prompts, Escape and typing stay local', async () => {
  const f = await openCanvas({ graph: { name: 'Character team', nodes: [], edges: [] } });
  try {
    const names = ['Researcher', 'Reviewer', 'Builder', 'Tester', 'Writer', 'Critic'];
    for (const name of names) {
      await f.canvas.getByText('Characters', { exact: true }).click();
      await f.canvas.getByRole('button', { name: `Add ${name}`, exact: true }).click();
    }
    await f.agentCount(6, 'all six presets'); await f.fit();
    const initial = await f.saved();
    for (const n of initial.nodes.filter(n => n.type === 'agent')) assert.ok(n.data.instruction.startsWith('You are '));
    const command = async number => {
      await f.page.keyboard.press('Escape');
      await f.canvas.locator('.react-flow__pane, .iso-board').first().click({ position: { x: 20, y: 20 } });
      await f.page.keyboard.press('Space');
      const field = f.canvas.getByRole('textbox', { name: 'Workflow pattern', exact: true });
      await field.waitFor(); await f.page.keyboard.type(String(number)); await f.page.keyboard.press('Enter');
    };
    await command(1);
    let saved = await f.saved(); assert.equal(saved.edges.length, 5);
    assert.deepEqual(saved.nodes.filter(n => n.type === 'agent').map(n => n.data.instruction), initial.nodes.filter(n => n.type === 'agent').map(n => n.data.instruction));
    await f.fit(); await f.node('Researcher').click();
    const prompt = f.canvas.getByRole('textbox', { name: 'Prompt', exact: true });
    await prompt.fill('My editable character prompt'); await prompt.press('Space');
    assert.equal(await f.canvas.getByRole('textbox', { name: 'Workflow pattern', exact: true }).count(), 0);
    assert.equal((await f.saved()).nodes.find(n => n.data.character === 'researcher').data.instruction, 'My editable character prompt ');
    await command(2); assert.equal((await f.saved()).edges.length, 0);
    await command(3); assert.equal((await f.saved()).template, 'kahn');
    await command(4);
    const rounds = f.canvas.getByRole('spinbutton', { name: 'Round limit', exact: true }); await rounds.fill('3');
    saved = await f.saved(); assert.equal(saved.roundLimit, 3); assert.ok(saved.edges.some(e => e.feedback));
    await rounds.fill(''); await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.canvas.getByText('Recursive workflows need a round limit from 1 to 100.', { exact: true }).waitFor(); assert.equal(f.runs.length, 0);
    await rounds.fill('3'); await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    try { await f.canvas.locator('.canvas-header [role="status"]').filter({ hasText: /^Finished/ }).waitFor(); }
    catch (error) { throw Error(`${error.message}\n${JSON.stringify({ runs: f.runs, plans: f.plans, header: await f.canvas.locator('.canvas-header').innerText(), notices: await f.canvas.locator('.canvas-notice').allInnerTexts() })}`); }
    assert.equal(f.runs.length, 1); assert.equal(f.runs[0].roundLimit, 3);
    assert.equal(f.runs[0].tasks.find(t => t.feedbackFrom?.length).feedbackFrom.length, 2, 'planner retains previous-round answer and check');
    assert.equal((await f.saved()).edges.filter(edge => edge.feedback).length, 1, 'the planner keeps the feedback link once');
    await command(5); assert.equal((await f.saved()).edges.length, 5);
    await f.page.keyboard.press('Space'); await f.canvas.getByRole('textbox', { name: 'Workflow pattern', exact: true }).press('Escape');
    assert.equal(await f.canvas.getByRole('textbox', { name: 'Workflow pattern', exact: true }).count(), 0);
    await command(5); await f.canvas.getByRole('button', { name: 'Side panel', exact: true }).click(); await fs.mkdir(shots, { recursive: true });
    for (const iso of [false, true]) {
      await f.canvas.getByRole('button', { name: iso ? 'Isometric' : 'Flat', exact: true }).click();
      if (iso) { await command(2); assert.equal((await f.saved()).edges.length, 0); await command(5); }
      for (const theme of ['light', 'dark']) {
        if (await f.page.locator('html').evaluate(el => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(f.page, theme); await f.fit();
        const selector = iso ? '.iso-node[data-kind="agent"]' : '.agent-node[data-kind="agent"]';
        const colors = await f.canvas.locator(selector).evaluateAll(nodes => nodes.map(n => getComputedStyle(n).getPropertyValue('--agent-color').trim()));
        assert.equal(new Set(colors).size, 6, `${iso}/${theme}: one color per character`);
        assert.equal(await f.canvas.locator(iso ? '.iso-portrait' : '.agent-portrait').count(), 6);
        if (iso) assert.deepEqual(await f.canvas.locator('.iso-portrait').evaluateAll(images => images.filter(image => {
          const label = document.querySelector(`.iso-label[data-for="${image.closest('.iso-node').dataset.id}"]`);
          const a = image.getBoundingClientRect(), b = label.getBoundingClientRect();
          return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        }).map(image => image.closest('.iso-node').dataset.id)), [], 'labels leave the character portraits visible');
        await f.page.screenshot({ path: `${shots}/${iso ? 'isometric' : 'flat'}-${theme}.png` });
      }
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
