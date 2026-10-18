const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

const PROFILE = '/tmp/personal-fixture/skills/personal/SKILL.md';
const TEXT = fs.readFileSync(path.join(__dirname, '../../../codex-rs/skills/src/assets/personal/SKILL.md'), 'utf8');
function routes() {
  let dismissed = false, created = false, content = TEXT, mtimeMs = 1;
  return {
    '/api/personal': body => {
      if (body?.action === 'dismiss') dismissed = true;
      if (body?.action === 'open') { dismissed = true; created = true; }
      return { path: PROFILE, showTip: !dismissed && !created };
    },
    '/api/file': body => {
      if (body) { assert.equal(body.cwd, path.dirname(PROFILE)); assert.equal(body.path, 'SKILL.md'); content = body.content; mtimeMs++; }
      return { content, mtimeMs, size: content.length };
    },
    '/api/files/dir': () => ({ data: [] }),
  };
}

for (const colorScheme of ['light', 'dark']) test(`personal tip opens the editable profile, slash command reopens it (${colorScheme})`, async () => {
  const f = await fixture({ colorScheme, width: 1280, height: 800, routes: routes() });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    const tip = f.page.getByRole('button', { name: 'Tell Elpis how you work: /personal', exact: true });
    await tip.waitFor();
    await assertUiFit(f.page.locator('.empty-state'), 'personal tip fits');
    await f.page.setViewportSize({ width: 900, height: 700 });
    await assertUiFit(f.page.locator('.empty-state'), 'personal tip fits a narrow window');
    await f.page.setViewportSize({ width: 1280, height: 800 });
    if (process.env.ELPIS_PARITY_SHOTS) await f.page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `personal-tip-${colorScheme}.png`) });
    await tip.click();
    const editor = f.page.getByRole('textbox', { name: `Contents of ${PROFILE}`, exact: true });
    await editor.waitFor();
    assert.equal(await editor.inputValue(), TEXT);
    await editor.fill(TEXT + 'Habits: Work in short steps.\n');
    const saved = f.page.waitForResponse(response => response.url().endsWith('/api/file') && response.request().method() === 'POST');
    await editor.press('Control+s');
    assert.equal((await saved).status(), 200);
    await f.page.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'detached' });
    assert.ok(f.posts.some(post => post.path === '/api/file' && post.body.content.includes('Work in short steps')));
    if (process.env.ELPIS_PARITY_SHOTS) await f.page.screenshot({ path: path.join(process.env.ELPIS_PARITY_SHOTS, `personal-editor-${colorScheme}.png`) });
    const refreshed = f.page.waitForResponse(response => response.url().endsWith('/api/personal') && response.request().method() === 'GET');
    await f.page.reload(); await refreshed; await f.composer.waitFor();
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await tip.count(), 0);
    await f.composer.fill('/personal'); await f.composer.press('Enter');
    await editor.waitFor(); assert.match(await editor.inputValue(), /Work in short steps/);
    assert.equal(f.posts.filter(post => /\/turns$/.test(post.path)).length, 0, 'the command never starts inference');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('dismissal survives reload without creating a personal skill', async () => {
  const f = await fixture({ routes: routes() });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    await f.page.getByRole('button', { name: 'Dismiss personal tip' }).click();
    await f.page.getByRole('button', { name: 'Dismiss personal tip' }).waitFor({ state: 'detached' });
    const refreshed = f.page.waitForResponse(response => response.url().endsWith('/api/personal') && response.request().method() === 'GET');
    await f.page.reload(); await refreshed; await f.composer.waitFor();
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    assert.equal(await f.page.getByRole('button', { name: 'Tell Elpis how you work: /personal' }).count(), 0);
    assert.ok(f.posts.some(post => post.path === '/api/personal' && post.body.action === 'dismiss'));
    assert.ok(!f.posts.some(post => post.path === '/api/personal' && post.body.action === 'open'));
  } finally { await f.close(); }
});

test('a failed profile open reports the failure and leaves the tip available', async () => {
  const profileRoutes = routes();
  const f = await fixture({ routes: { ...profileRoutes, '/api/personal': body => body?.action === 'open'
    ? { __http: 500, error: 'Personal profile cannot be created.' } : profileRoutes['/api/personal'](body) } });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    const tip = f.page.getByRole('button', { name: 'Tell Elpis how you work: /personal', exact: true });
    await tip.click();
    await f.page.getByRole('alert').filter({ hasText: 'Personal profile cannot be created.' }).waitFor();
    assert.equal(await tip.count(), 1);
    assert.equal(await f.page.getByRole('textbox', { name: `Contents of ${PROFILE}`, exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('returning to New chat refreshes first-use state changed by another client', async () => {
  const f = await fixture({ routes: routes() });
  try {
    await f.page.locator('.startup-splash').waitFor({ state: 'detached' });
    const tip = f.page.getByRole('button', { name: 'Tell Elpis how you work: /personal', exact: true });
    await tip.waitFor();
    await f.open('chat-a');
    const response = await fetch(new URL('/api/personal', f.page.url()), { method: 'POST', body: JSON.stringify({ action: 'open' }) });
    assert.equal(response.status, 200);
    const refreshed = f.page.waitForResponse(response => response.url().endsWith('/api/personal') && response.request().method() === 'GET');
    await f.page.locator('aside.sidebar').getByRole('button', { name: 'New chat', exact: true }).click();
    await refreshed;
    await tip.waitFor({ state: 'detached' });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
