const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { chooseTheme } = require('./controls.cjs');
const { dashboardRoutes } = require('./dashboard-fixture.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

// A132 (189f5bd0d): these interactions now belong to the shared TUI dashboard.
const token = 'a'.repeat(32);
const mother = { id: 'chat-a', title: 'Fix the parser', parent_id: null, model: 'gpt-6.1-sol', status: 'ready', status_label: 'Ready' };
const child = { id: 'worker-a', title: 'Iris', parent_id: mother.id, model: 'gpt-6-luna', status: 'ready', status_label: 'Ready' };
async function enter(f) {
  await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
  await f.page.getByRole('button', { name: 'Observability', exact: true }).click();
  const dashboard = f.page.frameLocator('iframe[title="Elpis dashboard"]');
  await dashboard.getByRole('tab', { name: 'Conversations & agents', exact: true }).click();
  return dashboard;
}
async function shot(page, name) {
  if (!process.env.ELPIS_SHOTS) return;
  await fs.mkdir(process.env.ELPIS_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, name + '.png') });
}

test('Observability hosts the TUI dashboard assets instead of a second desktop page', async () => {
  const f = await fixture({ width: 1440, height: 1000, routes: dashboardRoutes() });
  try {
    await f.page.getByRole('button', { name: 'Observability', exact: true }).click();
    const iframe = f.page.locator('iframe[title="Elpis dashboard"]');
    await iframe.waitFor({ timeout: 5000 }).catch(() => {});
    assert.equal(await iframe.count(), 1, 'R30: Observability must embed the shared TUI dashboard');
    assert.equal(await f.page.locator('.observed-agent, .observed-chat-row').count(), 0);
    const dashboard = f.page.frameLocator('iframe[title="Elpis dashboard"]');
    await dashboard.getByRole('tab', { name: 'Conversations & agents', exact: true }).waitFor();
    await dashboard.getByRole('tab', { name: 'Tokens', exact: true }).click();
    await dashboard.locator('#panel-tokens').waitFor();
    assert.equal(await dashboard.locator('#panel-tokens').count(), 1);
    await dashboard.getByRole('tab', { name: /Smart Prune/ }).click();
    await dashboard.getByText('Edit pruning instructions', { exact: true }).click();
    await dashboard.locator('#pruner-prompt').fill('My unsaved instructions');
    await chooseTheme(f.page, 'dark');
    assert.equal(await dashboard.locator('#pruner-prompt').inputValue(), 'My unsaved instructions');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});


test('returning to the chat list after a subagent deletion reloads its totals', async () => {
  for (const colorScheme of ['light', 'dark']) {
    let deleted = false, reads = 0;
    const routes = dashboardRoutes(), data = routes['/api/dashboard/data.json'];
    routes['/api/dashboard/agents.json'] = () => ({ agents: deleted ? [mother] : [mother, child] });
    routes['/api/dashboard/data.json'] = () => {
      reads++;
      const result = structuredClone(data());
      result.state.revision = deleted ? 10 : 9;
      result.state.smart_prune.approx_saved_tokens = deleted ? 0 : 1500;
      result.state.context.saved_tokens = deleted ? 0 : 1500;
      return result;
    };
    routes[`/api/dashboard/threads/${token}/worker-a`] = () => ({ thread: { id: child.id }, data: [{ item: { type: 'agentMessage', text: 'Unicode cases passed.' } }], nextCursor: null });
    const f = await fixture({ routes, colorScheme, width: 1280, height: 900 });
    try {
      const dashboard = await enter(f);
      await dashboard.locator(`[data-agent-id="${child.id}"]`).click();
      await dashboard.getByText('Unicode cases passed.', { exact: true }).waitFor();
      await dashboard.getByRole('tab', { name: /Smart Prune/ }).click();
      assert.equal(await dashboard.locator('#smart-saved').innerText(), '1.5k');
      const before = reads;
      deleted = true; f.emit('message', { method: 'thread/deleted', params: { threadId: child.id } });
      await dashboard.getByRole('tab', { name: 'Conversations & agents', exact: true }).click();
      await dashboard.locator(`[data-agent-id="${child.id}"]`).waitFor({ state: 'detached', timeout: 12000 });
      assert.ok(reads > before, 'the dashboard rereads the session after deletion');
      assert.deepEqual(await dashboard.locator('#agents-conversation option').allTextContents(), ['Fix the parser']);
      assert.equal(await dashboard.locator('#agent-chat').isVisible(), false, 'the deleted agent transcript closes');
      await dashboard.locator(`[data-agent-id="${mother.id}"]`).click();
      await dashboard.getByText('Parser fixed.', { exact: true }).waitFor();
      await dashboard.getByRole('button', { name: 'Close', exact: true }).click();
      await dashboard.getByRole('tab', { name: /Smart Prune/ }).click();
      assert.equal(await dashboard.locator('#smart-saved').innerText(), '0', 'returning must not retain deleted-agent savings');
      await shot(f.page, `dashboard-deletion-${colorScheme}`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});

test('MCP output and the full subagent prompt open with one click', async () => {
  const prompt = 'Verify Unicode cases. ' + 'Keep every word of this full delegated prompt. '.repeat(40) + 'END OF PROMPT';
  for (const colorScheme of ['light', 'dark']) {
    const routes = dashboardRoutes();
    routes[`/api/dashboard/threads/${token}/chat-a`] = () => ({ thread: { id: mother.id }, data: [
      { item: { type: 'collabAgentToolCall', tool: 'spawn_agent', prompt, status: 'completed' } },
      { item: { type: 'mcpToolCall', server: 'rag', tool: 'search', status: 'completed', result: { content: [{ type: 'text', text: 'README loaded.' }] } } },
    ], nextCursor: null });
    const f = await fixture({ routes, colorScheme, width: 1280, height: 900 });
    try {
      const dashboard = await enter(f);
      await dashboard.locator(`[data-agent-id="${mother.id}"]`).click();
      const mcp = dashboard.locator('#agent-chat-items article').filter({ hasText: 'rag · search · completed' });
      const delegation = dashboard.locator('#agent-chat-items article').filter({ hasText: 'collab Agent Tool Call' });
      for (const [item, expected] of [[mcp, 'README loaded.'], [delegation, 'END OF PROMPT']]) {
        const details = item.locator('details');
        assert.equal(await details.getAttribute('open'), null, 'details start folded');
        await details.locator('summary').click();
        assert.equal(await details.evaluate(element => element.open), true, 'one click opens the details');
        await details.getByText(expected, { exact: false }).waitFor();
      }
      assert.equal(await delegation.locator('details > div').innerText(), prompt, 'the complete delegated prompt is retained');
      await shot(f.page, `dashboard-details-${colorScheme}`);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
