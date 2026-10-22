const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { assertUiFit } = require('./ui-fit.cjs');

async function setup(options = {}) {
  const root = await fs.mkdtemp('/tmp/elpis-ledger-ui-');
  const skills = [['My skill', 'user'], ['Project skill', 'repo'], ['Built in', 'system'], ['Plugin skill', 'user', 'docs@local'], ['Managed skill', 'admin']].map(([name, scope, plugin]) => ({
    id: name, name, description: 'A throwaway skill for checking Customize.', path: `${root}/skills/${name}/SKILL.md`, scope, enabled: true, plugin: plugin || null,
    deletable: !plugin && ['user', 'repo'].includes(scope),
  }));
  const state = { skills: [...skills], deleted: null, fail: false };
  const reply = () => ({ skills: { data: state.skills, errors: [] }, plugins: { data: [] }, connectors: { data: [] } });
  const f = await fixture({ width: 1280, height: 800, ...options, routes: {
    '/api/customize': reply,
    '/api/customize/skill/delete': body => {
      if (state.fail) return { __http: 400, error: 'Could not move skill to Trash' };
      state.deleted = state.skills.find(skill => skill.path === body.path);
      assert.ok(state.deleted.deletable);
      state.skills = state.skills.filter(skill => skill !== state.deleted);
      return { ...reply(), deleted: { name: state.deleted.name, token: 'test-undo' } };
    },
    '/api/customize/skill/undo': body => { assert.equal(body.token, 'test-undo'); state.skills.push(state.deleted); return reply(); },
  } });
  return { ...f, state, root };
}
const row = (page, name) => page.locator('.customize-item').filter({ has: page.getByText(name, { exact: true }) });
const open = async page => { await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).click(); await page.getByRole('heading', { name: 'Your skills', exact: true }).waitFor(); };
const windowTitle = async (page, title) => { await page.waitForFunction(expected => document.title === expected, title); assert.equal(await page.title(), title); };

test('Customize names the sidebar, heading, command action and window; customize view identity is retained', async () => {
  const f = await setup();
  try {
    const { page } = f;
    await open(page);
    await page.getByRole('heading', { name: 'Customize', exact: true }).waitFor();
    await windowTitle(page, 'Customize — Elpis');
    assert.equal(await page.getByRole('button', { name: 'Customize', exact: true }).count(), 0);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search or start a chat' }).fill('Customize');
    const option = page.getByRole('option', { name: 'Customize', exact: true });
    await option.waitFor(); await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Customize', exact: true }).waitFor();
    await f.open('chat-a');
    assert.equal(await page.getByRole('group', { name: 'Elpis features', exact: true }).getByRole('button', { name: 'Ledger', exact: true }).count(), 1);
    assert.equal(await page.locator('.nav-list').getByRole('button', { name: 'Customize', exact: true }).count(), 1);
    await windowTitle(page, 'Elpis');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('heading', { name: 'Customize', exact: true }).waitFor();
    await windowTitle(page, 'Customize — Elpis');
    await page.locator('.nav-list').getByRole('button', { name: 'Workflows', exact: true }).click();
    await page.getByRole('region', { name: 'Workflows', exact: true }).waitFor();
    await windowTitle(page, 'Workflows · Elpis');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('heading', { name: 'Customize', exact: true }).waitFor();
    await windowTitle(page, 'Customize — Elpis');
    assert.equal(f.posts.some(post => post.path.includes('/delete')), false);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

for (const colorScheme of ['light', 'dark']) test(`deleting an owned skill with its Delete button confirms once, names its folder and restores with Undo (${colorScheme}, 1280px)`, async () => {
  const f = await setup({ colorScheme });
  try {
    const { page } = f; await open(page);
    await row(page, 'My skill').getByRole('button', { name: 'Delete My skill', exact: true }).click();
    const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
    assert.match(await dialog.innerText(), /My skill/);
    assert.ok((await dialog.innerText()).includes(`${f.root}/skills/My skill`));
    assert.equal(f.posts.filter(post => post.path.endsWith('/delete')).length, 0);
    await assertUiFit(dialog, 'confirmation fits');
    const shots = process.env.ELPIS_LEDGER_SHOTS;
    if (shots) { await fs.mkdir(shots, { recursive: true }); await page.locator('.startup-splash').waitFor({ state: 'detached' }); await page.screenshot({ path: path.join(shots, `ledger-confirm-${colorScheme}.png`) }); }
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await row(page, 'My skill').waitFor({ state: 'detached' });
    const notice = page.getByRole('status').filter({ hasText: 'Deleted My skill' }); await notice.waitFor();
    assert.match(await notice.innerText(), /Deleted My skill ·/);
    assert.equal(f.posts.filter(post => post.path.endsWith('/delete')).length, 1);
    if (shots) await page.screenshot({ path: path.join(shots, `ledger-deleted-${colorScheme}.png`) });
    await notice.getByRole('button', { name: 'Undo', exact: true }).click();
    await row(page, 'My skill').waitFor();
    assert.equal(f.posts.filter(post => post.path.endsWith('/undo')).length, 1);
    await assertUiFit(page.locator('.customize'), 'Customize fits at 1280');
    if (shots) await page.screenshot({ path: path.join(shots, `ledger-${colorScheme}.png`) });
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Delete on a focused project row confirms; cancel keeps it; errors stay in the dialog; notice expires after four seconds', async () => {
  const f = await setup();
  try {
    const { page } = f; await open(page);
    // Tab into the row using actual keyboard events.
    await page.getByRole('button', { name: 'Create skill', exact: true }).click();
    await open(page);
    await page.getByRole('radio', { name: 'Skills', exact: true }).click();
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press('Tab');
      if (await row(page, 'Project skill').evaluate(el => el === document.activeElement)) break;
    }
    assert.equal(await row(page, 'Project skill').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Delete');
    const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(f.posts.filter(post => post.path.endsWith('/delete')).length, 0);
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-skill-path')?.includes('/Project skill/'));
    await page.keyboard.press('Delete'); await dialog.waitFor();
    f.state.fail = true;
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: 'Could not move skill to Trash' }).waitFor();
    assert.equal(await row(page, 'Project skill').count(), 1);
    f.state.fail = false;
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
    const notice = page.getByRole('status').filter({ hasText: 'Deleted Project skill' }); await notice.waitFor();
    await page.waitForTimeout(3500); assert.equal(await notice.isVisible(), true);
    await notice.waitFor({ state: 'detached', timeout: 1500 });
    assert.equal(f.posts.filter(post => post.path.endsWith('/undo')).length, 0);
  } finally { await f.close(); }
});

test('bundled, plugin and managed skills explain their source and offer only turning off', async () => {
  const f = await setup();
  try {
    const { page } = f; await open(page);
    for (const name of ['Built in', 'Plugin skill', 'Managed skill']) {
      const item = row(page, name); await item.locator('.customize-badge').hover();
      const tooltip = page.locator('.hud-tooltip'); await tooltip.waitFor();
      assert.match(await tooltip.innerText(), /turned off instead/);
      assert.ok((await tooltip.innerText()).includes(`${f.root}/skills/${name}`));
      assert.match(await item.getAttribute('title'), /turned off instead/);
      assert.equal(await item.getByRole('button', { name: `Delete ${name}` }).count(), 0);
      assert.equal(await item.getByRole('switch').count(), 1);
      await item.click({ position: { x: 5, y: 5 } }); await page.keyboard.press('Delete');
      assert.equal(await page.getByRole('alertdialog').count(), 0);
    }
    assert.equal(f.posts.filter(post => post.path.endsWith('/delete')).length, 0);
  } finally { await f.close(); }
});
