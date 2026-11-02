// CloudRoom VM under Settings → Models & accounts (1 Nov, Masih: "I asked if we can use cloud room's vms for our agents.
// that's it. I have a sub there."): Sign in opens CloudRoom's page in his browser, then Check status and Sign out.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { fixture } = require('./parity-fixture.cjs');
const { openAccounts } = require('./providers-order.cjs');

for (const colorScheme of ['light']) test(`the CloudRoom VM row signs in, checks the VM and signs out (${colorScheme})`, async () => {
  let state = { signedIn: false, signingIn: false };
  const actions = [];
  const off = { state: 'notConnected', models: [], usage: [] };
  const app = await fixture({ colorScheme, storage: { 'elpis-theme': colorScheme }, routes: {
    '/api/providers': () => ({ openai: { auth: { state: 'signedOut' }, usage: [], usageError: null }, claude: off, gemini: off, openrouter: [] }),
    '/api/providers/cloudroom': body => {
      if (!body) { if (state.signingIn) state = { signedIn: true, signingIn: false, email: 'masih@example.com', kind: 'vm' }; return state; }
      actions.push(body.action);
      if (body.action === 'signIn') return { ...(state = { signedIn: false, signingIn: true }), url: 'https://www.cloudroom.dev/desktop?callback=x&state=y&challenge=z' };
      if (body.action === 'status') return { ...state, vm: { state: 'awake', claude: { installed: true, signedIn: true }, codex: { installed: false, signedIn: false } } };
      if (body.action === 'signOut') return (state = { signedIn: false, signingIn: false });
      return { __http: 400, error: 'no' };
    },
  } });
  const { page } = app;
  try {
    await openAccounts(page);
    const card = page.locator('[data-provider="cloudroom"]');
    await card.getByText('Not signed in', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Sign out', exact: true }).count(), 0, 'no Sign out before signing in');
    await card.getByRole('button', { name: 'Sign in', exact: true }).click();
    // Through the desktop's sign-in path (desktop/browser.cjs external-url), which opens his own browser.
    await page.waitForFunction(() => window.__commands.some(command => command.action === 'external-url'));
    const opened = await page.evaluate(() => window.__commands.filter(command => command.action === 'external-url'));
    assert.equal(opened.length, 1); assert.match(opened[0].url, /^https:\/\/www\.cloudroom\.dev\/desktop\?/, 'CloudRoom opens in his browser');
    await card.getByText('masih@example.com', { exact: false }).waitFor();
    await card.getByText('Signed in', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Check status', exact: true }).click();
    await card.getByRole('status').filter({ hasText: 'VM awake · Claude Code signed in · Codex not installed' }).waitFor();
    await fs.mkdir('/tmp/cloudroom-shots', { recursive: true });
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `/tmp/cloudroom-shots/settings-${colorScheme}.png` });
    await card.getByRole('button', { name: 'Sign out', exact: true }).click();
    await card.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.deepEqual(actions, ['signIn', 'status', 'signOut']);
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
