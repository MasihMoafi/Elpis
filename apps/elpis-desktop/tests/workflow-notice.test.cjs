// A workflow's end notice in the chat (SPEC WR5): it reaches the chat's model as a message, but Masih did not write it,
// so it shows as one step naming the run and how it ended, its result inside, as Claude Code shows a finished task;
// never a bubble of tags, and never one of his prompts for ↑ to bring back. Light and dark. No model calls.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');

const notice = (runId, name, status, summary, result) => ['<workflow-notification>', `<run-id>${runId}</run-id>`, `<name>${name}</name>`, `<status>${status}</status>`,
  `<summary>${summary}</summary>`, ...(result === undefined ? [] : [`<result>\n${JSON.stringify(result, null, 2)}\n</result>`]),
  ...(status === 'stopped' ? ['Do not restart it unless the person asks.'] : []), `<script-path>/runs/${runId}/script.js</script-path>`, `<journal>/runs/${runId}/journal.jsonl</journal>`, '</workflow-notification>'].join('\n');
const arrive = (f, turn, text, reply) => {
  f.emit('message', { method: 'turn/started', params: { threadId: 'chat-a', turn: { id: turn, status: 'inProgress', items: [] } } });
  f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: turn, item: { id: `${turn}-in`, type: 'userMessage', content: [{ type: 'text', text, text_elements: [] }] } } });
  f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: turn, item: { id: `${turn}-out`, type: 'agentMessage', text: reply } } });
  f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: turn, status: 'completed', items: [] } } });
};

for (const theme of ['light', 'dark']) test(`a workflow's end notice shows as a step with its outcome and result, not as his message (${theme})`, async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1300, height: 860 });
  try {
    if (theme === 'dark') await chooseTheme(f.page, 'dark'); // the fixture starts light
    assert.equal(await f.page.evaluate(() => document.documentElement.classList.contains('dark')), theme === 'dark');
    await f.open('chat-a');
    const content = f.page.locator('.chat-content');
    arrive(f, 'n1', notice('wf_1', 'review-auth', 'completed', 'Workflow "review-auth" completed: 6 agents, 41 s.', { confirmed: ['token refresh race'], total: 3 }), 'The review found one real bug: the token refresh race.');
    arrive(f, 'n2', notice('wf_2', 'migrate-tests', 'stopped', 'Workflow "migrate-tests" was stopped by the person after 4 agents.'), 'Understood; I will not restart it.');
    arrive(f, 'n3', notice('wf_3', 'sweep', 'failed', 'Workflow "sweep" failed: The script stopped without returning.'), 'The sweep failed before it returned.');
    const step = name => content.locator('.step').filter({ hasText: name });
    await content.getByText('The sweep failed before it returned.', { exact: true }).waitFor();
    assert.equal(await step('Workflow review-auth finished').count(), 1);
    assert.equal(await step('Workflow migrate-tests was stopped').count(), 1);
    assert.equal(await step('Workflow sweep failed').count(), 1);
    assert.match(await step('Workflow sweep failed').getAttribute('class'), /failed/, 'a failed run reads as failed');
    assert.equal(await content.getByText('workflow-notification', { exact: false }).count(), 0, 'no tags in the chat');
    assert.equal(await content.locator('.message.user').filter({ hasText: /review-auth|migrate-tests|sweep/ }).count(), 0, 'no notice shows as his own message');
    assert.equal(await content.getByText('Do not restart it unless the person asks.').count(), 0, 'what is meant for the model stays out of sight');
    // The result opens under the step.
    await step('Workflow review-auth finished').locator('.step-head').click();
    await step('Workflow review-auth finished').getByText('Workflow "review-auth" completed: 6 agents, 41 s.').waitFor();
    assert.match(await step('Workflow review-auth finished').locator('.step-output').innerText(), /"token refresh race"/);
    await f.page.screenshot({ path: path.join(process.env.ELPIS_TEST_SHOTS || os.tmpdir(), `workflow-notice-${theme}.png`) });
    // ↑ in the empty message box brings back his prompts only; a notice is not one.
    await f.composer.click(); await f.composer.press('ArrowUp');
    assert.doesNotMatch(await f.composer.inputValue(), /workflow-notification/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
