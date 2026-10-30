// Approved 29 Oct: one click opens an agent panel with what it did, output previews and its checker's verdict;
// while it works, the board card says in plain words what it is doing. Uses the recorded transcribe run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { openCanvas } = require('./canvas-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

const shots = process.env.ELPIS_SHOTS;
const id = 'agent-mvs4dw79-1c';
const graph = { name: 'Page One Translation', nodes: [{ id, type: 'agent', position: { x: 260, y: 90 }, data: {
  title: 'Transcribe Page One', instruction: 'Transcribe page one exactly.', model: 'gpt-6-luna', provider: 'openai',
  writeScopes: ['agents/transcribe-page-one'], acceptanceCriteria: ['A complete Markdown transcription exists.'],
} }], edges: [] };

for (const theme of ['light', 'dark']) test(`running card and finished output panel use plain words (${theme})`, async () => {
  const fixture = path.join(__dirname, 'fixtures/transcribe-sample');
  const record = JSON.parse(await fs.readFile(path.join(fixture, 'run.json'), 'utf8'));
  record.projectCwd = fixture;
  for (const task of record.tasks) task.cwd = fixture;
  const output = await import('../bridge/agent-output.mjs').then(module => module.agentOutput(record, id));
  let finished = false;
  const f = await openCanvas({ graph, agentOutput: output, listed(run) {
    const source = new Map(record.tasks.map(task => [task.id, task]));
    return { id: run.graphId, name: run.name, rootThreadId: run.rootThreadId, projectCwd: fixture,
      status: finished ? 'succeeded' : 'running', tasks: run.tasks.map(task => ({ ...task, ...source.get(task.id),
        status: finished ? 'succeeded' : task.kind === 'verify' ? 'pending' : 'running', assignedThreadId: `chat-${task.id}`,
        result: finished ? source.get(task.id)?.result ?? null : null,
        progress: task.kind === 'verify' ? [] : [{ kind: 'text', text: 'The source is page-1.png. I am checking every line against the image.', at: Date.now() }],
      })) };
  } });
  try {
    if (await f.page.locator('html').evaluate(element => element.classList.contains('dark')) !== (theme === 'dark')) await chooseTheme(f.page, theme);
    await f.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
    const card = f.node('Transcribe Page One');
    await card.getByText('Now: Checking every line against the image.').waitFor();
    assert.match(await card.innerText(), /Now: Checking every line against the image\./);
    await assertUiFit(card, `${theme} running agent card`);
    if (shots) { await fs.mkdir(shots, { recursive: true }); await f.page.screenshot({ path: path.join(shots, `${theme}-running-card.png`) }); }

    finished = true;
    await f.page.waitForFunction(() => /Finished/.test(document.querySelector('.canvas-header')?.textContent ?? ''));
    await card.click();
    const panel = f.canvas.getByRole('complementary', { name: 'Selected agent', exact: true });
    await panel.getByRole('heading', { name: 'What it did', exact: true }).waitFor();
    assert.match(await panel.innerText(), /page-1\.md contains the complete English text of page one/);
    assert.match(await panel.innerText(), /On the first day of that month/);
    assert.equal(await panel.getByText('Passed', { exact: true }).count(), 2);
    await assertUiFit(panel, `${theme} finished agent panel`);
    if (shots) await f.page.screenshot({ path: path.join(shots, `${theme}-finished-panel.png`) });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
