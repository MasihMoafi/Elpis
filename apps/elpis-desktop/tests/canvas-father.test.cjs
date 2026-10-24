// The Father: past the Mother's ten agents, the rest run under him in his own chat, once her part has succeeded, and
// he reports to her (lat.md/tasks.md, 17 October 2026). The bridge runs both stages (A41, 20 October): the fixture plays
// its part (tests/canvas-fixture.cjs), and the screen only sends the run and shows it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

test('past ten agents the Father runs the rest in his own chat, after the Mother, and reports to her', async () => {
  const { page, canvas, node, runs, posts, agentCount, fit, errors, close } = await openCanvas({
    listed: (run, looks) => looks ? { id: run.graphId, name: run.name, status: 'succeeded',
      tasks: run.tasks.map(task => ({ id: task.id, status: 'succeeded', assignedThreadId: null, result: { summary: `Accepted result: ${task.title}` } })) } : undefined,
  });
  try {
    const off = () => page.evaluate(() => document.activeElement?.blur());
    const father = canvas.locator('.react-flow__node-father');
    await agentCount(4, 'the default board');
    assert.equal(await father.count(), 0, 'no Father within ten agents');
    // Room for thirteen, then nine more agents, one prompt each.
    await canvas.getByRole('button', { name: 'Mother', exact: true }).click();
    const motherPanel = canvas.getByRole('complementary', { name: 'Mother', exact: true });
    await motherPanel.getByRole('textbox', { name: 'Max agents', exact: true }).fill('13');
    await off(); await page.keyboard.press('Tab');
    const command = canvas.getByRole('dialog', { name: 'Add agents', exact: true }).getByRole('textbox', { name: 'Command', exact: true });
    await command.waitFor();
    await page.keyboard.type(`9: ${Array.from({ length: 9 }, (_, index) => `Task ${index + 1}`).join('; ')}`);
    await page.keyboard.press('Enter');
    await agentCount(13, 'nine added');
    // Every agent gets a folder in one step.
    await off(); await page.keyboard.press('Control+a');
    const group = canvas.getByRole('complementary', { name: 'Selected agents', exact: true });
    await chooseOption(group.getByRole('combobox', { name: 'Add a folder', exact: true }), 'src');
    await group.getByRole('button', { name: 'Done', exact: true }).click();
    // The Father appears, starting his own agents; the Mother's panel says he reports to her.
    await fit();
    await father.waitFor();
    assert.match(await father.innerText(), /Father[\s\S]*Reports to the Mother[\s\S]*3 agents/i);
    await canvas.getByRole('button', { name: 'Mother', exact: true }).click();
    await motherPanel.getByText(/The Father runs 3 more agents in his own chat once her part has succeeded, and reports to her/).waitFor();
    await motherPanel.getByRole('button', { name: 'Done', exact: true }).click();

    // The run: her ten first, in her chat; when her part has succeeded, the bridge starts his three in his own chat and
    // delivers his report to hers. The screen sends one run and only shows what the bridge reports (A41).
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Finished'), null, { timeout: 15000 });
    assert.equal(posts.filter(post => post.path === '/api/workflows/run').length, 1, 'the screen sends one run');
    assert.equal(runs.length, 2, 'her run, then his, which the bridge started');
    const [hers, his] = runs, chats = posts.filter(post => post.path === '/api/threads');
    assert.deepEqual([hers.tasks.length, hers.next.tasks.length], [20, 6], 'ten agents and their checks for her; three and theirs for him');
    assert.equal(his.rootThreadId, 'chat-father', 'he has his own chat');
    assert.match(hers.next.thread.name, /^Father · /);
    assert.match(hers.next.thread.instructions, /You are the Father/);
    assert.deepEqual(chats.map(chat => chat.body.agents), [true], 'the screen opens only her chat, with the multi-agent runtime');
    const hisIds = new Set(his.tasks.map(task => task.id));
    assert.ok(his.tasks.every(task => task.dependsOn.every(id => hisIds.has(id))), 'his tasks wait only for his own');
    assert.ok(his.tasks.some(task => task.title === 'Nuvani · Join the parts'), 'the joiner, in the second wave, is his');
    assert.equal(posts.filter(post => /\/turns$/.test(post.path)).length, 0, 'the screen sends no report: the bridge does');
    // As on Deus Ex's board: a run clock, stopped once the run is done, and a log of what happened, newest last.
    assert.match(await canvas.getByLabel('Run clock').innerText(), /^Run done\s*\d\d:\d\d$/i);
    const lines = await canvas.getByRole('log', { name: 'Run log' }).locator('li').allInnerTexts();
    assert.ok(lines.length > 3, `${lines.length} log lines retain both parents' history`);
    assert.ok(lines.every(line => /^\+\d\d:\d\d/.test(line)), 'each line is stamped with the time since the run started');
    assert.ok(lines.some(line => /CHECK PASSED/.test(line)), lines.join(' | '));
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

const twelve = { name: 'Twelve writers', maxAgents: 12, edges: [], nodes: Array.from({ length: 12 }, (_, i) => ({
  id: `a${i + 1}`, type: 'agent', position: { x: 240 + Math.floor(i / 6) * 260, y: (i % 6) * 100 },
  data: { title: `Writer ${i + 1}`, instruction: 'Write the result', model: null, writeScopes: ['src'], acceptanceCriteria: [] },
})) };

test('a Father report the bridge could not deliver says why, and the run stays open without a second Father', async () => {
  const { page, canvas, runs, posts, errors, close } = await openCanvas({ graph: twelve, refuseReport: 'try again',
    listed: (run, looks) => looks ? { id: run.graphId, status: run.graphId === 'graph-1' ? 'succeeded' : 'failed',
      tasks: run.tasks.map(task => ({ id: task.id, status: 'succeeded', assignedThreadId: null, result: { summary: `Evidence ${task.id}` } })) } : undefined,
  });
  try {
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await canvas.getByRole('alert').filter({ hasText: 'Father report not delivered: try again' }).waitFor();
    assert.match(await canvas.locator('.canvas-header [role=status]').innerText(), /^Running/);
    assert.equal(runs.length, 2, 'no second Father run');
    assert.equal(posts.filter(post => /\/turns$/.test(post.path)).length, 0);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('a failed Mother does not start the Father or send his report', async () => {
  const { page, canvas, runs, posts, close } = await openCanvas({ graph: twelve,
    listed: (run, looks) => looks ? { id: run.graphId, status: 'failed', tasks: run.tasks.map(task => ({ id: task.id, status: 'failed', assignedThreadId: null })) } : undefined,
  });
  try {
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.canvas-header [role=status]')?.textContent?.includes('Finished'));
    assert.equal(runs.length, 1);
    assert.equal(posts.filter(post => post.path === '/api/threads').length, 1);
    assert.equal(posts.filter(post => /\/turns$/.test(post.path)).length, 0);
  } finally { await close(); }
});

test('an unchanged Father status waits for the next poll instead of polling continuously', async () => {
  const fatherReads = [];
  const { page, canvas, close } = await openCanvas({ graph: twelve, listed: (run, looks) => {
    if (run.graphId === 'graph-2') fatherReads.push(Date.now());
    return { id: run.graphId, status: looks < (run.graphId === 'graph-2' ? 3 : 1) ? 'running' : 'succeeded',
      tasks: run.tasks.map(task => ({ id: task.id, status: 'succeeded', assignedThreadId: null })) };
  } });
  try {
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.canvas-header [role=status]')?.textContent?.includes('Finished'), null, { timeout: 15000 });
    assert.ok(fatherReads[1] - fatherReads[0] >= 1000, `unchanged status repolled after ${fatherReads[1] - fatherReads[0]}ms`);
  } finally { await close(); }
});
