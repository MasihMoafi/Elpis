// 27 Oct: a workflow check's chat showed its raw JSON verdict ({"passed": false, "summary": …}). It shows a card:
// Check failed or Check passed, then the evidence. A reply that only looks like JSON stays as written.
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('a workflow check reply reads as Check failed or Check passed with its evidence, never raw JSON', async () => {
  const failed = JSON.stringify({ passed: false, summary: 'There is no `elpis-check.txt` in the workspace root.' });
  const passed = '```json\n' + JSON.stringify({ passed: true, summary: 'The file holds one line.' }) + '\n```';
  const other = JSON.stringify({ passed: true, summary: 'Three keys stay text.', score: 3 });
  const f = await fixture({ chat: [['t1', 'Check it.', failed], ['t2', 'Again.', passed], ['t3', 'And this?', other]] });
  try {
    await f.page.locator('aside').getByText('Fix the parser', { exact: true }).click();
    const cards = f.page.getByRole('region', { name: 'Check result' });
    await cards.nth(1).waitFor();
    assert.deepEqual(await cards.locator('.plan-card-heading').allInnerTexts().then(t => t.map(s => s.toLowerCase())), ['check failed', 'check passed']);
    assert.match(await cards.first().innerText(), /There is no elpis-check\.txt in the workspace root\./);
    assert.equal(await cards.count(), 2, 'a reply with other fields is not a check verdict');
    const text = await f.page.locator('.message.agent').allInnerTexts();
    assert.equal(text.filter(t => t.includes('"passed"')).length, 1, 'only the reply that is not a verdict shows its JSON');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

// 28 Oct: Mother's chat showed her prompt's evidence and her decision as raw JSON too.
test("Mother's decision reads as a card, and the evidence in her prompt folds away, pretty-printed", async () => {
  const decision = JSON.stringify({ action: 'steer', taskId: 'agent-1', message: 'Write hello.txt in the project root.', summary: 'The agent wrote the file elsewhere.', reason: 'The prompt names the root.' });
  const prompt = 'Workflow: Hello Check. Checkpoint task: agent-1.\nCurrent evidence:\n' + JSON.stringify([{ id: 'agent-1', status: 'running' }]);
  const f = await fixture({ chat: [['t1', prompt, decision]] });
  try {
    await f.page.locator('aside').getByText('Fix the parser', { exact: true }).click();
    const card = f.page.getByRole('region', { name: "Mother's decision" }); await card.waitFor();
    assert.equal((await card.locator('.plan-card-heading').textContent()).trim(), 'Mother steers the agent');
    assert.match(await card.innerText(), /The agent wrote the file elsewhere\.[\s\S]*Guidance:\s*Write hello\.txt in the project root\.[\s\S]*Why:\s*The prompt names the root\./);
    const turn = f.page.locator('.user-turn').first();
    assert.match(await turn.innerText(), /Workflow: Hello Check/);
    const fold = turn.locator('details'); assert.equal(await fold.getAttribute('open'), null, 'the evidence starts folded');
    await fold.locator('summary').click();
    assert.match(await fold.locator('pre').innerText(), /^\[\n  \{\n    "id": "agent-1"/, 'pretty-printed');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
