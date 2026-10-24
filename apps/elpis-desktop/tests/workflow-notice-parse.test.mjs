// The end notice as the app reads it (lib/workflow-notice.ts) from what the runtime writes (noticeText in
// tools/elpis-claude/workflow-runner.mjs): for any run name, status, summary and result, the app gets back exactly what
// the runtime put in; anything else the person sends stays their own message, and ↑ never brings a notice back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { noticeText } from '../../../tools/elpis-claude/workflow-runner.mjs';
import { forAll } from '../../../tools/elpis-claude/test/property.mjs';

// The app's @ alias under Node, without a build (as tests/canvas-editing.test.mjs does).
registerHooks({ resolve: (specifier, context, next) => next(specifier.startsWith('@/') ? new URL(`../${specifier.slice(2)}.ts`, import.meta.url).href : specifier, context) });
const { noticeOf, workflowNotice } = await import('../lib/workflow-notice.ts');
const { promptsOf } = await import('../lib/prompt-history.ts');

const message = text => ({ id: 'u', type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] });
function randomRun(g) {
  const status = g.pick(['completed', 'completed', 'stopped', 'failed']);
  const agents = Array.from({ length: g.size(5) }, () => ({ state: g.pick(['done', 'failed']) }));
  return {
    id: `wf_${g.int(0, 1e9)}`, name: `${g.text(8)}-${g.int(0, 99)}`.replaceAll('</', '< /'), status, agents, dir: `/runs/${g.text(6)}`, scriptPath: `/runs/${g.text(6)}/script.js`,
    createdAt: 1000, updatedAt: 2000, endedAt: 1000 + g.int(0, 1e6), result: status === 'completed' ? g.json(3) : null, error: status === 'failed' ? g.text(20).replaceAll('</', '< /') : null,
  };
}

test('every notice the runtime writes reads back with its run, name, status, summary and result', async () => {
  await forAll(300, g => {
    const run = randomRun(g), text = noticeText(run), read = workflowNotice(text);
    assert.ok(read, text);
    assert.equal(read.runId, run.id);
    assert.equal(read.name, run.name || 'workflow');
    assert.equal(read.status, run.status);
    assert.equal(read.summary, /<summary>([\s\S]*?)<\/summary>/.exec(text)[1]);
    assert.doesNotMatch(read.summary, /Do not restart/, 'what is meant for the model is not in the summary');
    if (run.status === 'completed') assert.deepEqual(JSON.parse(read.result), run.result ?? null);
    else assert.equal(read.result, null);
    assert.deepEqual(noticeOf(message(text)), read);
  });
});

test('a result too long for the notice reads back cut, with where the whole of it is', () => {
  const run = { id: 'wf_big', name: 'big', status: 'completed', agents: [], dir: '/runs/wf_big', scriptPath: '/runs/wf_big/script.js', createdAt: 0, updatedAt: 0, endedAt: 1, result: { text: 'x'.repeat(70_000) } };
  const read = workflowNotice(noticeText(run));
  assert.match(read.result, /… \(cut; the full result is in \/runs\/wf_big\/result\.json\)$/);
  assert.ok(read.result.length < 61_000);
});

test('only a whole notice is one: his own messages that mention or quote it stay his', async () => {
  for (const text of ['', 'run the workflow', 'what is a <workflow-notification>?', 'see:\n<workflow-notification>']) assert.equal(noticeOf(message(text)), null, JSON.stringify(text));
  assert.equal(noticeOf({ id: 'a', type: 'agentMessage', text: '<workflow-notification>' }), null);
  const run = { id: 'wf_1', name: 'one', status: 'completed', agents: [], dir: '/r', scriptPath: '/r/s.js', createdAt: 0, updatedAt: 0, endedAt: 0, result: 1 };
  assert.equal(noticeOf({ id: 'u', type: 'userMessage', content: [{ type: 'text', text: noticeText(run) }, { type: 'localImage', path: '/a.png' }] }), null, 'with an attachment it is his message');
  await forAll(50, g => {
    const entries = Array.from({ length: g.size(6) }, (_, i) => ({ turnId: `t${i}`, item: g.bool() ? message(noticeText({ ...run, id: `wf_${i}` })) : message(`asked ${i} ${g.text(8)}x`) }));
    assert.deepEqual(promptsOf(entries), entries.map(entry => entry.item.content[0].text).filter(text => !text.startsWith('<workflow-notification>')));
  });
});
