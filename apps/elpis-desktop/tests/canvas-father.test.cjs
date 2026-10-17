// The Father: past the Mother's ten agents, the rest run under him in his own chat, once her part has succeeded, and
// he reports to her (lat.md/tasks.md, 17 October 2026).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseOption } = require('./controls.cjs');

test('past ten agents the Father runs the rest in his own chat, after the Mother, and reports to her', async () => {
  const { page, canvas, node, runs, posts, agentCount, fit, errors, close } = await openCanvas();
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

    // The run: her ten first, in her chat; when her part has succeeded, his three in his own chat.
    await canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[role="status"]')?.textContent?.includes('Finished'), null, { timeout: 15000 });
    assert.equal(runs.length, 2);
    const [hers, his] = runs, chats = posts.filter(post => post.path === '/api/threads');
    assert.deepEqual([hers.tasks.length, his.tasks.length], [20, 6], 'ten agents and their checks for her; three and theirs for him');
    assert.notEqual(his.rootThreadId, hers.rootThreadId, 'he has his own chat');
    assert.match(chats[1].body.name, /^Father · /);
    assert.match(chats[1].body.instructions, /You are the Father/);
    const hisIds = new Set(his.tasks.map(task => task.id));
    assert.ok(his.tasks.every(task => task.dependsOn.every(id => hisIds.has(id))), 'his tasks wait only for his own');
    assert.ok(his.tasks.some(task => task.title === 'Join the parts'), 'the joiner, in the second wave, is his');
    // As on Deus Ex's board: a run clock, stopped once the run is done, and a log of what happened, newest last.
    assert.match(await canvas.getByLabel('Run clock').innerText(), /^Run done\s*\d\d:\d\d$/i);
    const lines = await canvas.getByRole('list', { name: 'Run log' }).locator('li').allInnerTexts();
    assert.ok(lines.length > 0 && lines.length <= 3, `${lines.length} log lines`);
    assert.ok(lines.every(line => /^\+\d\d:\d\d/.test(line)), 'each line is stamped with the time since the run started');
    assert.ok(lines.some(line => /: check passed$/.test(line)), lines.join(' | '));
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
