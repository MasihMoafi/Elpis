// lib/canvas.ts: what a Workflows run sends. In Voting the tally starts only after every answer and its check, and every
// agent and check writes its report in a folder of its own; the tally may also write the whole project.
import test from 'node:test';
import assert from 'node:assert/strict';
import './alias.mjs';
const { TEMPLATES, runTasks } = await import('../lib/canvas.ts');

test('Voting: the tally waits for all three answers and their checks; each task writes its report in its own folder', () => {
  const graph = TEMPLATES.find(template => template.id === 'voting').build();
  const tally = graph.nodes.find(node => /Tally the answers/.test(node.data.title));
  tally.data.writeScopes = [...tally.data.writeScopes, '.'];
  const { tasks } = runTasks(graph), by = Object.fromEntries(tasks.map(task => [task.title, task]));
  const answers = tasks.filter(task => task.kind === 'implement' && /Answer \d/.test(task.title));
  assert.equal(answers.length, 3);
  const tallyTask = by[tally.data.title];
  assert.deepEqual(new Set(tallyTask.dependsOn), new Set(answers.flatMap(answer => [answer.id, by[`Check: ${answer.title}`].id])), 'the tally reads only checked answers');
  for (const answer of answers) {
    const check = by[`Check: ${answer.title}`], folder = answer.writeScopes.at(-1);
    assert.match(folder, /^agents\/[a-z0-9-]+-answer-\d$/);
    assert.deepEqual(check.writeScopes, [`${folder}/check`]);
    assert.match(answer.instruction, new RegExp(`${folder}/report\\.md`));
    assert.match(check.instruction, new RegExp(`${folder}/check/report\\.md`));
    assert.doesNotMatch(check.instruction, /read.only/i, 'a check writes its own report');
  }
  assert.equal(tallyTask.writeScopes[0], '.', 'the tally may write the whole project');
  assert.equal(new Set(tasks.map(task => task.writeScopes.at(-1))).size, tasks.length, 'every task has a folder of its own');
});

test('Transcribe images: one reader per page (at most eight, shared evenly, in natural order); Elpis joins their pages', async () => {
  const { transcriptionTeam } = await import('../lib/canvas.ts');
  const files = ['notes.txt', ...Array.from({ length: 10 }, (_, i) => `screen-${i + 1}.png`).reverse()];
  const graph = transcriptionTeam('book/pages', files, { model: 'agy/gemini-3.8-flash-low', provider: null });
  const agents = graph.nodes.filter(node => node.type === 'agent'), readers = agents.slice(0, -1), join = agents.at(-1);
  assert.deepEqual(agents.map(agent => agent.data.title.split(' · ')[1]), ['Page 1', 'Pages 2–3', 'Page 4', 'Page 5', 'Page 6', 'Pages 7–8', 'Page 9', 'Page 10', 'Join the pages']);
  assert.ok(readers.every(agent => agent.data.model === 'agy/gemini-3.8-flash-low' && !agent.data.provider));
  assert.match(readers[1].data.instruction, /book\/pages\/screen-2\.png\n- book\/pages\/screen-3\.png/, 'shared pages stay in order');
  assert.match(readers[7].data.instruction, /book\/pages\/screen-10\.png/, 'pages in natural order');
  assert.match(readers[0].data.instruction, /own vision\. Do not run OCR/);
  assert.equal(agents.some(agent => agent.data.instruction.includes('notes.txt')), false, 'only images are pages');
  assert.deepEqual(join.data.join, { parts: readers.map(agent => `${agent.data.writeScopes[0]}/pages.md`), output: 'book/pages/transcription.md', flow: true });
  assert.deepEqual(join.data.writeScopes, ['book/pages']);
});

test('a pattern number rewires the same agents (5 Voting: three into one; 1 Sequential: one after another), keeping their identities', async () => {
  const { TEMPLATES, applyPattern } = await import('../lib/canvas.ts');
  const team = TEMPLATES.find(template => template.id === 'voting').build(), agents = graph => graph.nodes.filter(node => node.type === 'agent').map(node => node.id);
  const voting = applyPattern(team, 5), chained = applyPattern(voting, 1);
  assert.equal(voting.template, 'voting'); assert.equal(chained.template, 'sequential');
  assert.deepEqual(agents(chained), agents(team), 'the same agents');
  const last = agents(team).at(-1);
  assert.deepEqual(voting.edges.filter(edge => !edge.feedback).map(edge => edge.target), agents(team).slice(0, -1).map(() => last), 'every answer feeds the last');
  assert.equal(chained.edges.filter(edge => !edge.feedback).length, agents(team).length - 1, 'one after the other');
  assert.equal(applyPattern(team, 4).edges.filter(edge => edge.feedback).length, 1, 'Recursive adds one feedback wire');
});

test('starter and added agents get distinctive, unique names', async () => {
  const { TEMPLATES, newAgents } = await import('../lib/canvas.ts');
  assert.ok(TEMPLATES.find(template => template.id === 'voting').build().nodes.filter(node => node.type === 'agent').every(node => /^[A-Z][a-z]+ · /u.test(node.data.title)));
  const added = newAgents(8, { model: null }, { x: 0, y: 0 });
  assert.equal(new Set(added.map(node => node.data.title)).size, 8);
  assert.equal(new Set(added.map(node => `${node.position.x},${node.position.y}`)).size, 8, 'eight additions never overlap');
});
