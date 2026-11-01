// "Mother re-plans" on the board (1 Nov, Masih approved the dynamic workflow): one switch for the run, on by default;
// her decisions are lines in the run history, agents she adds appear on the board live and ones she cancels show cancelled.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');

const graph = { name: 'Re-plan team', edges: [], nodes: ['a', 'b'].map((id, index) => ({ id, type: 'agent', position: { x: 260, y: 40 + index * 160 },
  data: { title: id === 'a' ? 'Section writer' : 'Index builder', instruction: `Write part ${id}.`, model: null, writeScopes: ['src'], acceptanceCriteria: ['It exists'] } })) };

test('the Mother re-plans switch is on for a new run and its setting reaches the run', async () => {
  const f = await openCanvas({ graph, autoLayout: false });
  try {
    await f.canvas.getByRole('button', { name: 'Mother agent', exact: true }).click();
    const toggle = f.canvas.getByRole('switch', { name: 'Mother re-plans', exact: true });
    assert.equal(await toggle.getAttribute('aria-checked'), 'true', 'on by default');
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.canvas.locator('.canvas-header').getByRole('status').filter({ hasText: 'Finished' }).waitFor();
    assert.equal(f.runs.at(-1).replan, true);
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelectorAll('.canvas-header [role="status"]').length > 0);
    await f.page.waitForTimeout(300);
    assert.equal(f.runs.at(-1).replan, false, 'turned off, the run is sent without re-planning');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('her decisions are history lines; an added agent appears with its wire, a cancelled one shows cancelled', async () => {
  const f = await openCanvas({ graph, autoLayout: false, listed(run, looks) {
    const added = looks > 0, done = looks > 2;
    const tasks = run.tasks.map(task => ({ id: task.id, title: task.title, kind: task.kind, dependsOn: task.dependsOn, assignedThreadId: null,
      status: task.id.startsWith('a') ? 'succeeded' : added ? 'cancelled' : 'pending', ...(added && !task.id.startsWith('a') ? { cancelledBy: 'mother' } : {}) }));
    if (added) tasks.push(
      { id: 'fact-4', title: 'Fact-checker 4', kind: 'implement', addedBy: 'mother', dependsOn: ['a', 'a-check'], writeScopes: ['agents/fact-checker-4'], status: done ? 'succeeded' : 'running', assignedThreadId: null },
      { id: 'fact-4-check', title: 'Check: Fact-checker 4', kind: 'verify', addedBy: 'mother', dependsOn: ['fact-4'], status: done ? 'succeeded' : 'pending', assignedThreadId: null });
    const decisions = added ? [{ at: 1, kind: 'replan', decision: 'add', summary: 'Added: Fact-checker 4 — section 4 was missed' }, { at: 2, kind: 'replan', decision: 'cancel', summary: 'Cancelled: Index builder — the writer covered it' }] : [];
    return { id: run.graphId, status: done ? 'succeeded' : 'running', tasks, mother: { decisions } };
  } });
  try {
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const log = f.canvas.getByRole('log', { name: 'Run log', exact: true });
    await log.getByText('MOTHER · Added: Fact-checker 4 — section 4 was missed').waitFor();
    await log.getByText('MOTHER · Cancelled: Index builder — the writer covered it').waitFor();
    await f.node('Fact-checker 4').waitFor();
    assert.equal(await f.canvas.locator('.react-flow__edge[data-id="a->fact-4"]').count(), 1, 'the added agent is wired after the one it builds on');
    assert.equal(await f.node('Index builder').locator('.agent-node').getAttribute('data-status'), 'cancelled');
    await f.canvas.locator('.canvas-header').getByRole('status').filter({ hasText: 'Finished' }).waitFor();
    const texts = await log.locator('li').allTextContents();
    assert.equal(texts.filter(text => text.includes('MOTHER · Added')).length, 1, 'each decision is told once');
    assert.ok(texts.some(text => /AGENT STARTED · Fact-checker 4/.test(text)), 'an added agent is named in the log from its first line');
    assert.ok(!texts.some(text => /Untitled/.test(text)));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
