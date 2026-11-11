// W5 (11 Nov, Masih: "This is exactly the kind of shadow or silent errors I've begged you to solve"): History showed a failed
// run as the bare word "failed". Each failed run now says why, from its record, and offers the one next step that fits.
// The runs below are his four failed "Voting" runs of 10 Nov, as their records end, plus a run stopped by its time limit.
import type { Page } from 'playwright-core';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
type Fixture = { page: Page; errors: string[]; close(): Promise<void> };
const { fixture }: { fixture(options?: object): Promise<Fixture> } = require('./parity-fixture.cts');
type TestWindow = typeof window & { __folders: string[] };

const task = (title: string, status: string, extra = {}) => ({ id: title, title, status, ...extra });
const PROVIDER = 'Quillon · Answer 1: {"error":{"message":"provider `anthropic-credits` returned 400 Bad Request: ' +
  'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the';
const GIT = "Workflow Git operation failed: fatal: a branch named 'elpis/run/candidate-agent-1q-r1' already exists";
const RUNS = [
  { id: 'run-provider', rootThreadId: 'chat-a', name: 'Voting 7', status: 'failed', error: PROVIDER,
    tasks: [task('Quillon · Answer 1', 'failed', { assignedThreadId: 'chat-b', failureReason: PROVIDER }), task('Veyra · Answer 2', 'succeeded')] },
  { id: 'run-scope', rootThreadId: 'chat-a', name: 'Voting 8', status: 'failed',
    error: '“Quillon · Answer 1” changed files outside its write scopes: answer-1.md. Kept at /tmp/kept/agent-1n-r1',
    tasks: [task('Quillon · Answer 1', 'failed', { assignedThreadId: 'chat-b' }), task('Nuvani · Tally', 'blocked')] },
  { id: 'run-git', rootThreadId: 'chat-c', name: 'Voting 10', status: 'failed', error: GIT,
    tasks: [task('Nuvani · Tally', 'failed', { assignedThreadId: 'chat-b', failureReason: GIT })] },
  { id: 'run-limit', rootThreadId: 'chat-c', name: 'Long survey', status: 'cancelled', error: 'Stopped at its 60-minute time limit.',
    tasks: [task('Reader', 'cancelled')] },
  { id: 'run-stopped', rootThreadId: 'chat-a', name: 'Stopped by him', status: 'cancelled', tasks: [task('Reader', 'cancelled')] },
  { id: 'run-ok', rootThreadId: 'chat-a', name: 'Voting 12', status: 'succeeded', tasks: [task('Veyra · Answer 2', 'succeeded')] },
];

test('History says why each failed run ended and offers the next step that fits; a finished run shows neither', async () => {
  // The runs are listed once the app is up: listed at start, their chats would leave the sidebar row the fixture waits for.
  let listed = false;
  const f = await fixture({ routes: { '/api/workflows/history': () => ({ data: listed ? RUNS : [] }) } });
  listed = true;
  try {
    const { page } = f;
    await page.evaluate(() => {
      (window as TestWindow).__folders = [];
      if (!window.elpisDesktop) throw Error('Desktop bridge missing');
      window.elpisDesktop.openFolder = async folder => { (window as TestWindow).__folders.push(folder); };
    });
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const canvas = page.getByRole('region', { name: 'Workflows', exact: true });
    await canvas.getByRole('button', { name: 'History', exact: true }).click();
    const rows = page.getByRole('region', { name: 'Workflow history' }).locator('li');
    await rows.first().waitFor();
    const read = async (name: string) => {
      const row = rows.filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
      return { row, reason: await row.locator('.workflow-history-reason').allInnerTexts(), steps: await row.getByRole('button').allInnerTexts() };
    };
    const provider = await read('Voting 7');
    assert.deepEqual(provider.reason, ['Quillon · Answer 1 stopped with an error: provider anthropic-credits returned 400 Bad Request: ' +
      'messages.1.content.0: Invalid signature in thinking block.']);
    assert.equal(provider.steps[0], "Open the agent's chat");
    const scope = await read('Voting 8');
    assert.deepEqual(scope.reason, ['Quillon · Answer 1 changed files it was not given: answer-1.md. Its work is kept.']);
    assert.equal(scope.steps[0], 'Open kept work');
    const git = await read('Voting 10');
    assert.deepEqual(git.reason, ["Elpis could not prepare the branch for Nuvani · Tally: a branch named 'elpis/run/candidate-agent-1q-r1' " +
      "already exists. The agent's work was not the cause."]);
    assert.equal(git.steps[0], "Open the run's chat");
    const limit = await read('Long survey');
    assert.deepEqual([limit.reason, limit.steps[0]], [['Stopped at its 60-minute time limit.'], "Open the run's chat"]);
    for (const name of ['Voting 12', 'Stopped by him']) {
      const quiet = await read(name);
      assert.deepEqual(quiet.reason, [], `${name} has no reason line`);
      assert.equal(quiet.steps.length, 2, `${name} keeps only its open and remove buttons`);
    }
    // Each step does what it says: the kept work opens in the file manager; the agent's chat opens.
    await scope.row.getByRole('button', { name: 'Open kept work', exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as TestWindow).__folders), ['/tmp/kept/agent-1n-r1']);
    await provider.row.getByRole('button', { name: "Open the agent's chat", exact: true }).click();
    await canvas.waitFor({ state: 'hidden' });
    await page.locator('.workspace-header').filter({ hasText: 'Write the docs' }).waitFor();
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
