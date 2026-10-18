// Each workspace page in the sidebar has an icon from one family: a vector that takes the text colour. On 18 Oct Love
// Spot showed a 512px photo instead. Local bridge fixture (tests/parity-fixture.cjs).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');

test('every sidebar page icon is a text-coloured vector, Love Spot included', async () => {
  const f = await fixture({ width: 1280 });
  try {
    const nav = f.page.locator('aside.sidebar nav[aria-label="Workspace"]');
    await nav.getByRole('button', { name: 'Love Spot', exact: true }).waitFor();
    const icons = await nav.locator('button').evaluateAll(buttons => buttons.map(button => {
      const icon = button.firstElementChild, paint = icon?.tagName === 'svg' ? icon.getAttribute('fill') === 'currentColor' || icon.getAttribute('stroke') === 'currentColor' : false;
      return `${button.textContent.trim()}: ${icon?.tagName}${paint ? ' currentColor' : ''}`;
    }));
    assert.ok(icons.some(line => line.startsWith('Love Spot')), icons.join('\n'));
    assert.deepEqual(icons.filter(line => !line.endsWith('svg currentColor')), [], 'icons outside the family');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Agents is absent from workspace navigation and commands; Workflows and sidebar Agent runs remain', async () => {
  const f = await fixture({ routes: { '/api/threads': (_, url) => ({ data: url.searchParams.has('ancestorThreadId') ? [] : [
    { id: 'chat-a', name: 'Parent chat', status: { type: 'idle' } },
    { id: 'run-a', name: 'Retained agent run', parentThreadId: 'chat-a', source: { subAgent: { thread_spawn: { agent_path: '/root/check' } } }, status: { type: 'idle' } },
  ], nextCursor: null }) } });
  try {
    const { page } = f;
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    const nav = page.locator('.nav-list');
    assert.equal(await nav.getByRole('button', { name: /^Agents\b/ }).count(), 0);
    for (const name of ['Workflows', 'Love Spot', 'Observability']) assert.equal(await nav.getByRole('button', { name, exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Agent runs (1)', exact: true }).click();
    await page.getByRole('region', { name: 'Agent runs', exact: true }).getByText('Retained agent run', { exact: true }).waitFor();
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search or start a chat' }).fill('Agents');
    assert.equal(await page.getByRole('option', { name: 'Agents', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await f.composer.fill('/agents');
    assert.equal(await page.getByRole('option', { name: /^\/agents\b/ }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
