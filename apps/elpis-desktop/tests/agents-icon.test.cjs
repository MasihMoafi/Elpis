const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, CWD } = require('./parity-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const { checkAgentsIcon } = require('./agents-icon-check.cjs');

const parent = { id: 'chat-a', name: 'Agents icon acceptance', cwd: CWD, status: { type: 'idle' } };
const children = Array.from({ length: 16 }, (_, i) => ({ id: `agent-${i}`, name: i === 8 ? 'An agent with a very long descriptive name '.repeat(8) : `Agent ${i + 1}`, cwd: CWD, parentThreadId: parent.id, source: { subAgent: { thread_spawn: { agent_path: `/root/agent-${i}` } } }, status: { type: ['idle', 'notLoaded', 'systemError'][i % 3] } }));

for (const theme of ['light', 'dark']) test(`Agents shares the Elpis team icon in ${theme}, open, closed and after reload`, async () => {
  const f = await fixture({ staticDir: process.env.ELPIS_RENDERER_OUT, width: 1440, height: 1000, routes: {
    '/api/threads': (_, url) => ({ data: url.searchParams.has('ancestorThreadId') ? children : [parent, ...children], nextCursor: null }),
    ...Object.fromEntries(children.flatMap(thread => [
      [`/api/threads/${thread.id}`, () => thread.id === 'agent-7' ? { __http: 409, error: 'Recorded agent request refused' } : { thread, data: [], nextCursor: null }],
      [`/api/threads/${thread.id}/resume`, () => ({ thread, activeTurnId: null })],
    ])),
  } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    if (theme === 'dark') await chooseTheme(page, theme);
    await f.open('chat-a');
    if (process.env.ELPIS_A103_SHOTS) {
      await fs.mkdir(process.env.ELPIS_A103_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ELPIS_A103_SHOTS, `renderer-${theme}-100.png`) });
    }
    const { path: artwork } = await checkAgentsIcon(page);
    assert.equal(await page.locator('.team-row').count(), 17, 'all sixteen agents and parent stay listed');
    for (const index of [0, 8, 15]) {
      await page.locator('.team-row:not(.root)').nth(index).click();
      await checkAgentsIcon(page);
    }
    await page.locator('.team-row:not(.root)').nth(7).click();
    await page.getByText('Error: Recorded agent request refused', { exact: true }).waitFor();
    await checkAgentsIcon(page);
    await page.locator('.team-row.root').click();
    await page.reload();
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.open('chat-a');
    await checkAgentsIcon(page);
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    const workflowPanel = page.getByRole('button', { name: 'Side panel', exact: true });
    await workflowPanel.waitFor();
    assert.equal(await workflowPanel.locator('svg[data-icon="agents"] path').getAttribute('d'), artwork, 'workflow agents panel shares the artwork');
    assert.equal(await workflowPanel.locator('.lucide-panel-right, .lucide-panel-right-close').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('a chat without agents has no Agents button or panel', async () => {
  const f = await fixture();
  try {
    await f.open('chat-a');
    assert.equal(await f.page.getByRole('button', { name: /^(Show|Hide) agents panel$/ }).count(), 0);
    assert.equal(await f.page.locator('.team-panel').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
