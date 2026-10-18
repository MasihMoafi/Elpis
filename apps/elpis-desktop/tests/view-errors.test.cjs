// One bad reply from the bridge must not take the window down. Every view and panel is opened against an empty reply, a
// null reply and a server error; the window stays up, nothing needs the safety net (components/view-boundary.tsx), and a
// view that read the reply says what went wrong in its own place. The safety net itself is checked with a reply that is
// well formed but holds something the transcript cannot draw. Real clicks and keys; local bridge fixture, no engine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');

const MESSAGE = 'The bridge broke';
const REPLIES = {
  'an empty object': { status: 200, body: '{}' },
  'null': { status: 200, body: 'null' },
  'a server error': { status: 500, body: JSON.stringify({ error: { message: MESSAGE } }) },
};
/** What the views read, apart from the thread list and the model catalogue the app needs to start. */
const PATHS = new Set(['/api/settings', '/api/customize', '/api/mcp', '/api/hooks', '/api/providers', '/api/providers/settings', '/api/tools/transcription', '/api/tools/rag',
  '/api/context/switches', '/api/workflows', '/api/folders', '/api/repository', '/api/files', '/api/threads/chat-a/context', '/api/threads/chat-a/git']);
const LISTS = ['ancestorThreadId', 'searchTerm', 'archived'];
const isBad = url => PATHS.has(url.pathname) || (url.pathname === '/api/threads' && LISTS.some(key => url.searchParams.has(key)));
const SETTINGS_PAGES = ['General', 'Notifications', 'Appearance', 'Keyboard shortcuts', 'Voice', 'Personalization', 'Usage & limits', 'Archived chats', 'Models & accounts', 'MCP servers', 'Git', 'Worktrees', 'Hooks', 'Configuration'];

async function using(reply, run, { bad = isBad, size = {} } = {}) {
  const f = await fixture({ width: 1280, height: 800, ...size });
  try {
    await f.page.route(url => bad(new URL(url)), route => route.fulfill({ contentType: 'application/json', ...reply }));
    await f.page.reload();
    await f.page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').waitFor();
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await run(f);
    assert.deepEqual(f.errors, [], 'nothing was thrown outside React');
  } finally { await f.close(); }
}
/** The window is still there, and no view fell back to its safety net. */
async function stands(f, label) {
  const { page } = f;
  await page.waitForTimeout(300);
  assert.equal(await page.getByText(/This page couldn.t load/).count(), 0, `${label}: the window did not blank`);
  assert.equal(await page.locator('.view-error').count(), 0, `${label}: the view read the reply without needing its safety net`);
  assert.equal(await page.getByRole('navigation', { name: /Workspace|Settings navigation/ }).first().isVisible(), true, `${label}: navigation is still there`);
}
const says = (reply, locator) => reply.status === 500 ? locator.getByText(MESSAGE, { exact: false }).first().waitFor() : locator.getByText(/could not read/i).first().waitFor();

for (const [name, reply] of Object.entries(REPLIES)) {
  test(`${name}: Ledger, Agents, Canvas, New agent and every Settings page stay up`, () => using(reply, async f => {
    const { page } = f;
    await page.locator('.nav-list').getByRole('button', { name: 'Ledger', exact: true }).click();
    await says(reply, page.getByLabel('Ledger', { exact: true }).first());
    await stands(f, 'Ledger');
    await page.getByRole('button', { name: 'Agents', exact: true }).click();
    await page.getByRole('button', { name: 'New agent', exact: true }).first().waitFor();
    await stands(f, 'Agents');
    await page.getByRole('button', { name: 'New agent', exact: true }).first().click();
    await stands(f, 'New agent');
    await page.getByRole('button', { name: 'Workflows', exact: true }).click();
    await stands(f, 'Workflows');
    for (const tab of SETTINGS_PAGES) {
      await openSettings(page);
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await stands(f, `Settings > ${tab}`);
    }
  }));

  test(`${name}: the slash panels, the @ list and the Changes tab say what failed in their own place`, () => using(reply, async f => {
    const { page, composer } = f;
    await f.open('chat-a');
    await composer.click(); await composer.fill('/diff'); await page.keyboard.press('Enter');
    await says(reply, page.getByRole('dialog', { name: 'Changes', exact: true }));
    await stands(f, '/diff');
    await page.keyboard.press('Escape');
    await composer.fill('@'); await page.waitForTimeout(400);
    await stands(f, '@ list');
    await composer.fill('');
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    await page.getByRole('button', { name: 'Changes', exact: true }).click();
    await says(reply, page.getByRole('region', { name: 'Side panel', exact: true }));
    await stands(f, 'Changes tab');
  }));

  test(`${name}: the chat's own reads (children, search, history) leave the sidebar and the box working`, () => using(reply, async f => {
    const { page, composer } = f;
    await page.getByLabel('Search conversations', { exact: true }).fill('parser');
    await page.getByText(/Could not search saved conversations/).waitFor();
    await stands(f, 'search');
    await page.getByLabel('Search conversations', { exact: true }).fill('');
    await f.open('chat-b');
    await composer.fill('still typing');
    assert.equal(await composer.inputValue(), 'still typing');
    await stands(f, 'a chat opened with its children unreadable');
  }));
}

test('a history reply with no messages shows the error in the chat and the other chats still open', () => using({ status: 200, body: JSON.stringify({ thread: { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } }, nextCursor: null }) }, async f => {
  const { page } = f;
  await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
  await page.locator('.workspace-notices').getByText(/could not read/i).waitFor();
  await stands(f, 'a history without messages');
  await f.open('chat-b');
  assert.equal(await page.locator('.workspace-notices').getByText(/could not read/i).count(), 0, 'the next chat opens clean');
}, { bad: url => url.pathname === '/api/threads/chat-a' }));

test('a message the transcript cannot draw is caught where it is: the chat says so, the sidebar and the box keep working, and another chat clears it', () => using(
  { status: 200, body: JSON.stringify({ thread: { id: 'chat-a', name: 'Fix the parser', cwd: '/tmp/parity-fixture', model: 'sol', modelProvider: 'openai', status: { type: 'idle' } }, nextCursor: null,
    data: [{ turnId: 't1', item: { id: 'a1', type: 'agentMessage', text: { not: 'a string' } } }, { turnId: 't1', item: { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Explain the parser.' }] } }] }) },
  async f => {
    const { page, composer } = f;
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    const net = page.locator('.view-error');
    await net.waitFor();
    assert.match(await net.innerText(), /conversation could not be shown/i);
    assert.equal(await page.getByText(/This page couldn.t load/).count(), 0);
    assert.equal(await composer.isEnabled(), true, 'the box still takes a message');
    await composer.fill('draft survives'); assert.equal(await composer.inputValue(), 'draft survives');
    await net.getByRole('button', { name: 'Try again', exact: true }).click();
    await net.waitFor();                      // the same reply fails the same way, in the same place
    await f.open('chat-b');
    assert.equal(await page.locator('.view-error').count(), 0, 'another chat does not carry the failure');
  }, { bad: url => url.pathname === '/api/threads/chat-a' }));
