// CI renderer regression checks; real bridge acceptance: settings2.runtime.cjs.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings } = require('./controls.cjs');
const settings = { version: 'v1', main: {}, background: {}, smartPrune: { explicitOverride: {} }, memory: {}, write: { available: true } };
async function setup(t, theme = 'light') {
  const files = Object.fromEntries(['instructions', 'memory'].map(kind => [kind, { content: '', version: 'missing', path: kind === 'instructions' ? '/isolated/AGENTS.md' : '/isolated/memories/MEMORY.md' }]));
  let refuse = false;
  const routes = { '/api/settings': () => settings, '/api/about': () => ({ version: '0.4.1', commit: '123456789abcdef', releaseNotes: 'https://github.com/MasihMoafi/Elpis/releases' }) };
  for (const kind of Object.keys(files)) routes[`/api/settings/files/${kind}`] = body => {
    if (body && refuse) return { __http: 409, error: 'File changed elsewhere. Reload before saving.' };
    if (body) files[kind] = { ...files[kind], content: body.content, version: 'saved' };
    return files[kind];
  };
  const f = await fixture({ height: 1080, routes, storage: { 'elpis-theme': theme } });
  t.after(() => f.close());
  await openSettings(f.page);
  return { ...f, files, reject: () => { refuse = true; } };
}
async function visit(page, name) { await page.getByRole('tab', { name, exact: true }).click(); return page.getByRole('tabpanel'); }
async function shot(page, name) {
  if (!process.env.ELPIS_SETTINGS2_SHOTS) return;
  await fs.mkdir(process.env.ELPIS_SETTINGS2_SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(process.env.ELPIS_SETTINGS2_SHOTS, `${name}.png`) });
}
for (const theme of ['light', 'dark']) {
  test(`SETTINGS2: file editors preserve drafts, save both files, reject conflicts (${theme})`, async t => {
    const f = await setup(t, theme), p = f.page;
    await visit(p, 'Personalization');
    try {
      for (const [kind, label] of [['instructions', 'Global instructions'], ['memory', 'Memory file']]) {
        const field = p.getByRole('textbox', { name: label, exact: true });
        await field.waitFor(); await field.fill(`# ${label}\nفارسی\n${'long '.repeat(500)}`);
        await visit(p, 'General'); await visit(p, 'Personalization');
        assert.match(await field.inputValue(), /فارسی/);
        await field.press('Control+s');
        await p.getByRole('status').filter({ hasText: `${label} saved.` }).waitFor();
        assert.match(f.files[kind].content, /فارسی/);
      }
      await p.reload(); await openSettings(p); await visit(p, 'Personalization');
      const field = p.getByRole('textbox', { name: 'Global instructions', exact: true });
      await p.waitForFunction(() => document.querySelector('textarea[aria-label="Global instructions"]')?.value.includes('فارسی'));
      assert.match(await field.inputValue(), /فارسی/);
      await field.fill('Unsent correction');
      p.once('dialog', dialog => dialog.dismiss());
      await p.reload({ timeout: 1500 }).catch(() => {});
      assert.equal(await field.inputValue(), 'Unsent correction', 'reload cancellation keeps draft');
      p.once('dialog', dialog => dialog.accept()); await p.reload();
      await openSettings(p); await visit(p, 'Personalization');
      await p.waitForFunction(() => document.querySelector('textarea[aria-label="Global instructions"]')?.value === 'Unsent correction');
      assert.equal(await field.inputValue(), 'Unsent correction', 'accepted reload restores journaled draft');
      f.reject(); await p.getByRole('button', { name: 'Save Global instructions', exact: true }).click();
      await p.getByRole('alert').filter({ hasText: 'File changed elsewhere' }).waitFor();
      assert.equal(await field.inputValue(), 'Unsent correction');
      p.once('dialog', dialog => dialog.dismiss());
      await p.getByRole('button', { name: 'Reload Global instructions', exact: true }).click();
      assert.equal(await field.inputValue(), 'Unsent correction');
      await shot(p, `personalization-${theme}`);
    } catch (error) { await shot(p, `before-personalization-${theme}`); throw error; }
  });
  test(`SETTINGS2: interface/code size and corners apply across routes and reload (${theme})`, async t => {
    const { page: p } = await setup(t, theme); await visit(p, 'Appearance');
    try {
      for (const label of ['Interface size', 'Code size']) await p.getByRole('radiogroup', { name: label, exact: true }).getByRole('radio', { name: 'Large', exact: true }).click();
      await p.getByRole('radiogroup', { name: 'Corner style', exact: true }).getByRole('radio', { name: 'Rounded', exact: true }).click();
      await p.reload(); await openSettings(p); await visit(p, 'Appearance');
      for (const label of ['Interface size', 'Code size']) assert.equal(await p.getByRole('radiogroup', { name: label, exact: true }).getByRole('radio', { name: 'Large', exact: true }).getAttribute('aria-checked'), 'true');
      assert.equal(await p.locator('html').getAttribute('data-corners'), 'rounded');
      await visit(p, 'General');
      assert.equal(await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--code-size').trim()), '16px');
      assert.equal(await p.evaluate(() => getComputedStyle(document.documentElement).fontSize), '18px');
      await visit(p, 'Appearance'); await shot(p, `appearance-${theme}`);
    } catch (error) { await shot(p, `before-appearance-${theme}`); throw error; }
  });
  test(`SETTINGS2: sleep preference survives reload (${theme})`, async t => {
    const { page: p } = await setup(t, theme); await visit(p, 'General');
    try {
      const control = p.getByRole('switch', { name: 'Prevent sleep while Elpis is working', exact: true });
      await control.click(); await p.reload(); await openSettings(p); await visit(p, 'General');
      assert.equal(await control.getAttribute('aria-checked'), 'true'); await shot(p, `general-${theme}`);
    } catch (error) { await shot(p, `before-general-${theme}`); throw error; }
  });
  test(`SETTINGS2: shortcuts filter actions, typed combinations, keypresses and no matches (${theme})`, async t => {
    const { page: p } = await setup(t, theme); await visit(p, 'Keyboard shortcuts');
    try {
      const search = p.getByRole('textbox', { name: 'Search keyboard shortcuts', exact: true });
      const settingsRow = p.getByRole('tabpanel').locator('.settings-row-title').filter({ hasText: /^Settings$/ });
      await search.fill('Settings'); await settingsRow.waitFor();
      await search.fill('Ctrl+,'); await settingsRow.waitFor();
      await search.fill(''); await search.press('Control+Shift+p');
      assert.match(await search.inputValue(), /Ctrl\+Shift\+P/i);
      await search.fill('not-a-shortcut'); await p.getByText('No shortcuts match', { exact: false }).waitFor();
      await search.fill('Ctrl'); await shot(p, `shortcuts-${theme}`);
    } catch (error) { await shot(p, `before-shortcuts-${theme}`); throw error; }
  });
  test(`SETTINGS2: About shows installed identity, live updates, restart errors and notes (${theme})`, async t => {
    const { page: p } = await setup(t, theme);
    await p.addInitScript(() => { window.elpisDesktop.updates = { status: async () => ({ available: false, restarting: false, error: null }), subscribe: callback => { window.__update = callback; return () => {}; }, restart: async () => { throw Error('Wait for the voice call'); } }; });
    await p.reload(); await openSettings(p);
    try {
      await visit(p, 'About'); await p.getByText('0.4.1', { exact: true }).waitFor();
      await p.getByText('123456789abcdef', { exact: true }).waitFor();
      assert.match(await p.getByRole('link', { name: 'Release notes', exact: true }).getAttribute('href'), /releases/);
      await p.evaluate(() => window.__update({ available: true, restarting: false, error: null }));
      await p.getByRole('tabpanel').getByRole('button', { name: 'Update ready · Restart', exact: true }).click();
      await p.getByRole('alert').filter({ hasText: 'Wait for the voice call' }).waitFor();
      await shot(p, `about-${theme}`);
    } catch (error) { await shot(p, `before-about-${theme}`); throw error; }
  });
}
