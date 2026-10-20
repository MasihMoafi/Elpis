const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('Lab hides the number for until-finished, sends ten, and keeps earlier experiments after New experiment', async () => {
  const f = await fixture();
  const saved = [], requests = [];
  await f.page.route('**/api/experiment-lab**', async route => {
    const request = route.request(), url = new URL(request.url());
    let record;
    if (request.method() === 'POST') {
      const data = request.postDataJSON(); requests.push(data);
      record = { id: `record-${saved.length + 1}`, status: 'completed', startedAt: new Date(2026, 9, 20, 12, saved.length).toISOString(), model: 'gpt-6-luna', request: data, trials: [], error: null };
      saved.unshift(record);
    } else record = url.searchParams.has('id') ? saved.find(item => item.id === url.searchParams.get('id')) : saved[0] ?? null;
    await route.fulfill({ json: { record, entries: saved.map(item => ({ id: item.id, startedAt: item.startedAt, status: item.status, task: item.request.task })) } });
  });
  try {
    await f.page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Lab', exact: true }).click();
    const lab = f.page.getByRole('region', { name: 'Lab', exact: true });
    const repeat = lab.getByRole('radiogroup', { name: 'Repeat', exact: true });
    await lab.getByRole('spinbutton', { name: 'Repetitions', exact: true }).waitFor();
    await repeat.getByRole('radio', { name: 'Until the task finishes', exact: true }).click();
    assert.equal(await lab.getByRole('spinbutton').count(), 0);
    assert.match(await lab.innerText(), /stops after 10 repetitions/i);
    await lab.getByRole('textbox', { name: 'Task', exact: true }).fill('First task');
    await lab.getByRole('textbox', { name: 'Expected answer', exact: true }).fill('42');
    await lab.getByRole('button', { name: 'Run comparison', exact: true }).click();
    assert.equal(requests[0].stopWhen, 'solved'); assert.equal(requests[0].repetitions, 10);
    await lab.getByRole('table', { name: 'Comparison', exact: true }).waitFor();
    await lab.getByRole('button', { name: 'New experiment', exact: true }).click();
    assert.equal(await lab.getByRole('textbox', { name: 'Task', exact: true }).inputValue(), '');
    assert.equal(await lab.getByRole('textbox', { name: 'Expected answer', exact: true }).inputValue(), '');
    assert.equal(await lab.getByRole('table', { name: 'Comparison', exact: true }).count(), 0);
    assert.match(await lab.getByRole('region', { name: 'Saved experiments' }).innerText(), /First task/);
    await lab.getByRole('textbox', { name: 'Task', exact: true }).fill('Second task');
    await lab.getByRole('textbox', { name: 'Expected answer', exact: true }).fill('43');
    await lab.getByRole('spinbutton', { name: 'Repetitions', exact: true }).fill('4');
    await lab.getByRole('button', { name: 'Run comparison', exact: true }).click();
    assert.equal(requests[1].stopWhen, 'count'); assert.equal(requests[1].repetitions, 4);
    const history = lab.getByRole('region', { name: 'Saved experiments' });
    const names = await history.getByRole('button').allTextContents();
    assert.equal(names.length, 2);
    assert.match(names[0], /Second task.*completed/);
    assert.match(names[1], /First task.*completed/);
    await history.getByRole('button', { name: /First task/ }).click();
    assert.equal(await lab.getByRole('textbox', { name: 'Task', exact: true }).inputValue(), 'First task');
    await lab.getByRole('table', { name: 'Comparison', exact: true }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
