import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentOutput, firstSentence, listedFiles, verdictLine, whatItDid } from './agent-output.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, '../tests/fixtures/transcribe-sample');

test('a finished agent becomes plain work, output previews, and checker verdicts', async () => {
  const record = JSON.parse(await fs.readFile(path.join(fixture, 'run.json'), 'utf8'));
  record.projectCwd = fixture;
  for (const task of record.tasks) task.cwd = fixture;

  const output = await agentOutput(record, 'agent-mvs4dw79-1c');
  assert.equal(output.did, 'page-1.md contains the complete English text of page one in reading order.');
  assert.deepEqual(output.outputs.map(file => file.path), ['agents/transcribe-page-one/page-1.md']);
  assert.match(output.outputs[0].lines[0], /^On the first day of that month/);
  assert.equal(output.outputs[0].abs, undefined, 'the response does not expose an absolute local path');
  assert.deepEqual(output.check.verdicts.map(item => item.state), ['passed', 'passed']);
  assert.match(output.check.verdicts[0].criterion, /Markdown file contains the complete English transcription/);
});

test('report parsing accepts the checker forms agents actually write', () => {
  assert.equal(firstSentence('B.C. is a date. Next sentence.'), 'B.C. is a date.');
  assert.equal(whatItDid('## Result\n\nDone. `out/file.md` holds the result. More.'), 'file.md holds the result.');
  assert.deepEqual(listedFiles('## Files\n- `a.md`\n- [B](docs/b.md)\n- `a.md`'), ['a.md', 'docs/b.md']);
  assert.deepEqual(verdictLine('**Passed — Criterion one.** Direct evidence.'), { state: 'passed', criterion: 'Criterion one.', detail: 'Direct evidence.' });
  assert.deepEqual(verdictLine('Criterion two: failed'), { state: 'failed', criterion: 'Criterion two', detail: '' });
});

test('an output path outside the run or through a link is never previewed', async t => {
  const root = await fs.mkdtemp(path.join(path.dirname(fixture), 'agent-output-'));
  const outside = await fs.mkdtemp(path.join(path.dirname(fixture), 'agent-output-outside-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'agents/writer/check'), { recursive: true });
  await fs.writeFile(path.join(root, 'agents/writer/report.md'), '## Result\nWrote the safe file.\n\n## Files\n- `agents/writer/safe.txt`\n- `agents/writer/outside.txt`\n- `../outside.txt`\n');
  await fs.writeFile(path.join(root, 'agents/writer/safe.txt'), 'safe\n');
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside\n');
  await fs.symlink(path.join(outside, 'outside.txt'), path.join(root, 'agents/writer/outside.txt'));
  const record = { projectCwd: root, tasks: [
    { id: 'writer', kind: 'implement', cwd: root, writeScopes: ['agents/writer'] },
    { id: 'writer-check', kind: 'verify', cwd: root, writeScopes: ['agents/writer/check'] },
  ] };
  assert.deepEqual((await agentOutput(record, 'writer')).outputs.map(file => file.path), ['agents/writer/safe.txt']);
});
