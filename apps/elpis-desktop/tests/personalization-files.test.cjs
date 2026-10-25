// S4, R40: a file that does not exist reads "Not created yet", and a file that exists can be previewed rendered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { captureReview, openSettings } = require('./controls.cjs');
const { settingsBody } = require('./settings-fixture.cjs');

const home = '/home/person/.elpis-next';
const routes = {
  '/api/settings': () => settingsBody(),
  '/api/settings/files/instructions': () => ({ path: `${home}/AGENTS.md`, content: '', version: 'missing' }),
  '/api/settings/files/memory': () => ({ path: `${home}/memories/MEMORY.md`, content: '# Saved memory\n\n- Prefers short replies', version: 'v1' }),
};

test('a missing instructions file says so and a memory file previews rendered', async () => {
  const f = await fixture({ routes }), { page } = f;
  try {
    await page.locator('.startup-splash').waitFor({ state: 'detached' });
    await openSettings(page); await page.getByRole('tab', { name: 'Personalization', exact: true }).click();
    const instructions = page.getByRole('region', { name: 'Global instructions', exact: true });
    await instructions.getByText(`${home}/AGENTS.md · not created yet`).waitFor();
    assert.match(await instructions.getByRole('textbox', { name: 'Global instructions', exact: true }).getAttribute('placeholder'), /Not created yet/);
    await instructions.getByRole('radio', { name: 'Preview', exact: true }).click();
    await instructions.getByText(/Not created yet\. Switch to Edit and save to create it\./).waitFor();

    const memory = page.getByRole('region', { name: 'Memory file', exact: true });
    await memory.getByText(`${home}/memories/MEMORY.md`, { exact: true }).waitFor();
    assert.match(await memory.getByRole('textbox', { name: 'Memory file', exact: true }).inputValue(), /^# Saved memory/);
    await instructions.getByRole('radio', { name: 'Edit', exact: true }).click();
    await captureReview(page, 'personalization-files-edit-light');
    await memory.getByRole('radio', { name: 'Preview', exact: true }).click();
    await memory.getByRole('heading', { name: 'Saved memory', exact: true }).waitFor();
    assert.equal(await memory.getByRole('listitem').filter({ hasText: 'Prefers short replies' }).count(), 1);
    assert.equal(await memory.getByRole('textbox').count(), 0, 'the preview replaces the editor');
    await memory.getByRole('radio', { name: 'Edit', exact: true }).click();
    assert.equal(await memory.getByRole('textbox', { name: 'Memory file', exact: true }).isVisible(), true);
    assert.equal(await instructions.getByRole('alert').count(), 0);
    assert.equal(await memory.getByRole('alert').count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('Personalization files recover locally, preview text without images, and preserve editable drafts', async () => {
  for (const [kind, label, name] of [['instructions', 'Global instructions', 'AGENTS.md'], ['memory', 'Memory file', 'memories/MEMORY.md']]) {
    const colorScheme = kind === 'memory' ? 'dark' : 'light';
    let unavailable = true, file = { path: `${home}/${name}`, content: '# Local text\n\n![Stored figure](https://preview.invalid/figure.png)', version: 'v1' };
    const endpoint = `/api/settings/files/${kind}`;
    const f = await fixture({ colorScheme, routes: { ...routes, [endpoint]: body => {
      if (unavailable) return { __http: 503, error: 'This file could not be read.' };
      if (body) file = { ...file, content: body.content, version: 'v2' };
      return file;
    } } }), { page } = f;
    const images = [];
    await page.route('https://preview.invalid/**', route => { images.push(route.request().url()); return route.fulfill({ status: 200, body: '' }); });
    try {
      await openSettings(page); await page.getByRole('tab', { name: 'Personalization', exact: true }).click();
      const group = page.getByRole('region', { name: label, exact: true });
      await group.getByRole('alert').filter({ hasText: 'could not be read' }).waitFor();
      assert.equal(await group.getByText('Loading the engine’s file…', { exact: true }).count(), 0);
      assert.equal(await group.getByRole('button', { name: `Reload ${label}`, exact: true }).isEnabled(), true);
      unavailable = false;
      await group.getByRole('button', { name: `Reload ${label}`, exact: true }).click();
      const editor = group.getByRole('textbox', { name: label, exact: true });
      await editor.waitFor();
      await page.waitForFunction(label => !document.querySelector(`textarea[aria-label="${label}"]`).disabled, label);
      assert.equal(await editor.inputValue(), file.content);
      const fillsRow = async field => {
        const geometry = await field.evaluate(element => {
          const field = element.getBoundingClientRect(), row = element.closest('.settings-row-control').getBoundingClientRect();
          return { width: field.width, available: row.width, left: field.left - row.left };
        });
        assert.ok(Math.abs(geometry.width - geometry.available) <= 1 && Math.abs(geometry.left) <= 1, `the file field fills its row: ${JSON.stringify(geometry)}`);
      };
      await fillsRow(editor);
      await captureReview(page, `personalization-${kind}-loaded-edit-${colorScheme}`);
      await group.getByRole('radio', { name: 'Preview', exact: true }).click();
      await group.getByRole('heading', { name: 'Local text', exact: true }).waitFor();
      assert.equal(await group.locator('img').count(), 0);
      assert.deepEqual(images, [], 'a text preview never requests image resources');
      const preview = group.getByLabel(`${label} preview`, { exact: true });
      await fillsRow(preview);
      await captureReview(page, `personalization-${kind}-text-preview-${colorScheme}`);
      await page.setViewportSize({ width: 390, height: 844 });
      await fillsRow(preview);
      await group.getByRole('radio', { name: 'Edit', exact: true }).click();
      await fillsRow(editor);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.setViewportSize({ width: 1130, height: 660 });
      await editor.fill('Keep this local draft');
      await page.getByRole('tab', { name: 'General', exact: true }).click();
      await page.getByRole('tab', { name: 'Personalization', exact: true }).click();
      assert.equal(await editor.inputValue(), 'Keep this local draft');
      await editor.press('Control+s');
      await group.getByRole('status').filter({ hasText: `${label} saved.` }).waitFor();
      assert.equal(file.content, 'Keep this local draft');
      assert.equal(await group.getByRole('alert').count(), 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
