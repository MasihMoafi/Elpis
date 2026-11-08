const { test } = require('node:test');
const assert = require('node:assert/strict');

const { openCanvas } = require('./canvas-fixture.cts');
const { chooseTheme, captureReview } = require('./controls.cts');
const { assertUiFit } = require('./ui-fit.cts');

type Run = { graphId: string; tasks: { id: string }[] };

test('a failed writer explains why its descendants did not start', async () => {
  const end = 'End of the complete workflow failure details.';
  const reason = `Writable success requires changed files.\n${Array.from({ length: 40 }, (_, index) => `Check ${index + 1}: the filesystem command failed; review the agent's evidence before running again.`).join('\n')}\nRequest: ${'a'.repeat(180)}\n${end}`;
  const fixture = await openCanvas({ listed(run: Run) {
    return { id: run.graphId, status: 'failed', tasks: run.tasks.map((task, index) => ({ id: task.id, status: index === 0 ? 'failed' : 'blocked', assignedThreadId: null, failureReason: index === 0 ? reason : 'prerequisite did not succeed' })) };
  } });
  try {
    await fixture.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const notice = fixture.canvas.getByRole('alert').filter({ hasText: 'Writable success requires changed files' }); await notice.waitFor();
    const run = fixture.canvas.getByRole('button', { name: 'Run graph', exact: true });
    await fixture.agents.first().click();
    const selected = fixture.canvas.locator('.react-flow__node-agent.selected');
    assert.equal(await selected.count(), 1);
    const ids = await fixture.agents.evaluateAll((nodes: HTMLElement[]) => nodes.map(node => node.dataset.id));
    const initialDetails = notice.getByRole('region', { name: 'Workflow error details', exact: true });
    await initialDetails.focus(); await initialDetails.press('Control+a');
    assert.equal(await selected.count(), 1, 'selecting error text does not select every agent');
    await initialDetails.press('Backspace');
    assert.deepEqual(await fixture.agents.evaluateAll((nodes: HTMLElement[]) => nodes.map(node => node.dataset.id)), ids, 'reading an error cannot delete agents');
    await fixture.page.evaluate(() => window.getSelection()?.removeAllRanges());
    for (const width of [960]) for (const theme of ['light']) {
      await fixture.page.setViewportSize({ width, height: 900 });
      if (await fixture.page.locator('html').evaluate((el: HTMLElement) => el.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(fixture.page, theme);
      for (const iso of [false, true]) {
        await fixture.canvas.getByRole('radio', { name: iso ? 'Isometric' : 'Flat', exact: true }).click();
        const at = await notice.boundingBox(), canvas = await fixture.canvas.boundingBox(), header = await fixture.canvas.locator('.canvas-header').boundingBox();
        assert.ok(at.x >= canvas.x && at.x + at.width <= canvas.x + canvas.width + 1, 'a long failure stays inside its workspace');
        assert.ok(at.y >= header.y + header.height && Math.abs(at.y + at.height - canvas.y - canvas.height) <= 14, 'failures occupy the bottom without covering the header');
        assert.equal(await notice.evaluate((el: HTMLElement) => !!el.closest('.canvas-header')), false, 'no error popup remains under Run');
        assert.equal(await run.getAttribute('aria-describedby'), await notice.getAttribute('id'), 'Run still describes its actual failure');
        const details = notice.getByRole('region', { name: 'Workflow error details', exact: true });
        assert.ok((await details.innerText()).includes(end), 'the complete failure remains available');
        const scroll = await details.evaluate((el: HTMLElement) => ({ client: el.clientHeight, full: el.scrollHeight, fits: el.scrollWidth <= el.clientWidth + 1 }));
        assert.ok(scroll.full > scroll.client && scroll.fits, 'long details scroll vertically and wrap unbroken text');
        await details.focus(); await details.press('End');
        // Native keyboard scrolling can finish after the key event returns. Wait for the actual scroll end;
        // the following range assertion still proves that the complete final line is readable.
        await fixture.page.waitForFunction((el: HTMLElement) => el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1, await details.elementHandle());
        assert.equal(await details.evaluate((el: HTMLElement, ending: string) => {
          const text = el.firstChild; if (!text?.textContent) throw Error('Missing error details');
          const start = text.textContent.indexOf(ending), range = document.createRange();
          range.setStart(text, start); range.setEnd(text, start + ending.length);
          const tail = range.getBoundingClientRect(), box = el.getBoundingClientRect();
          return el.scrollTop > 0 && tail.top >= box.top - 1 && tail.bottom <= box.bottom + 1;
        }, end), true, 'keyboard scrolling reaches the final readable line');
        await details.press('Home');
        await fixture.page.waitForFunction((el: HTMLElement) => el.scrollTop === 0, await details.elementHandle());
        await assertUiFit(notice, `bottom workflow failure ${width} ${theme} ${iso ? '3D' : '2D'}`);
        await captureReview(fixture.page, `workflow-failure-${width}-${theme}-${iso ? '3d' : '2d'}`);
      }
    }
    await notice.getByRole('button', { name: 'Dismiss', exact: true }).click(); await notice.waitFor({ state: 'hidden' });
    assert.equal(await run.getAttribute('aria-describedby'), null, 'dismissal removes the stale error description');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});

test('a new workflow can be designed at laptop width while the previous run keeps working', async () => {
  const fixture = await openCanvas({ width: 1366, graph: { name: 'Existing work', nodes: [
    { id: 'mother', type: 'mother', position: { x: 0, y: 0 }, data: {} },
    { id: 'writer', type: 'agent', position: { x: 300, y: 0 }, data: { title: 'Keep working', instruction: 'Complete the existing task.', model: null, writeScopes: ['src'], acceptanceCriteria: ['Return the result'] } },
  ], edges: [] }, listed(run: Run) { return { id: run.graphId, status: 'running', tasks: run.tasks.map(task => ({ id: task.id, status: 'running', assignedThreadId: null })) }; } });
  try {
    const { canvas } = fixture;
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await canvas.getByText('Wait for this run to finish before starting another.', { exact: true }).waitFor();
    const request = canvas.getByRole('textbox', { name: 'Workflow request', exact: true });
    assert.equal(await request.isEnabled(), true, 'an active run does not lock the next workflow request');
    await request.fill('from scratch: prepare the next independent workflow');
    const create = canvas.getByRole('button', { name: 'New workflow', exact: true });
    assert.equal(await create.isEnabled(), true);
    await assertUiFit(canvas.locator('.canvas-header'), 'new workflow remains reachable on a laptop during a run');
    await create.click(); await fixture.agentCount(2, 'the new draft opens');
    assert.equal(fixture.runs.length, 1, 'designing a new workflow does not start another run');
    assert.equal(fixture.runs[0].ended, undefined, 'the previous run is still running');
    assert.equal(fixture.posts.some((post: { path: string }) => /interrupt|cancel|resume/.test(post.path)), false, 'the previous run is never stopped');
    assert.deepEqual(fixture.errors, []);
  } finally { await fixture.close(); }
});
