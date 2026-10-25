const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chooseOption } = require('./controls.cjs');
const { PAGES, settingsFixture, visit, captureSettings, measureRows, violations } = require('./settings-row-audit.cjs');

test('every Settings page uses shared rows and consistent computed sizing in light and dark', async () => {
  const problems = [];
  for (const theme of ['light', 'dark']) {
    const app = await settingsFixture(theme), measurements = [];
    try {
      for (const name of PAGES) {
        await visit(app.page, name);
        if (['Configuration', 'General'].includes(name)) {
          const panel = app.page.getByRole('tabpanel', { name, exact: true });
          await chooseOption(panel.getByLabel(name === 'General' ? 'Speed' : 'Default permissions', { exact: true }), name === 'General' ? 'fast' : 'ask');
          await panel.getByRole('status').filter({ hasText: 'saved' }).waitFor();
        }
        const measurement = await app.page.evaluate(measureRows);
        if (!['Models & accounts', 'MCP servers', 'Usage & limits'].includes(name)) assert.ok(measurement.rows.length, `${name}: fixture must render rows`);
        measurements.push({ name: `page ${name}`, measurement });
        if (process.env.ELPIS_SETTINGS_EVIDENCE) {
          const dir = path.join(process.env.ELPIS_SETTINGS_EVIDENCE, theme); await fs.mkdir(dir, { recursive: true });
          await captureSettings(app.page, dir, `page-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
        }
      }
      if (process.env.ELPIS_SETTINGS_EVIDENCE) await fs.writeFile(path.join(process.env.ELPIS_SETTINGS_EVIDENCE, `${theme}-measurements.json`), JSON.stringify(measurements, null, 2));
      problems.push(...violations(measurements).map(problem => `${theme}: ${problem}`));
      assert.deepEqual(app.errors, []);
    } finally { await app.close(); }
  }
  assert.deepEqual(problems, [], 'computed row contract');
});

test('row audit rejects a hand-written row and independently catches title, description and control drift', async () => {
  const app = await settingsFixture();
  try {
    await visit(app.page, 'Configuration');
    const base = await app.page.evaluate(measureRows);
    const group = app.page.locator('.settings-rows').filter({ visible: true }).first();
    await group.evaluate(group => {
      const row = group.querySelector('.settings-row').cloneNode(true); row.removeAttribute('data-slot'); row.removeAttribute('data-elpis-source');
      row.querySelectorAll('[data-elpis-source]').forEach(el => el.removeAttribute('data-elpis-source'));
      group.append(row);
    });
    assert.ok(violations([{ name: 'injected', measurement: await app.page.evaluate(measureRows) }]).some(text => text.includes('outside shared component')));
    await group.locator(':scope > .settings-row').last().evaluate(el => el.remove());
    await group.evaluate(group => {
      const row = document.createElement('div'); row.id = 'unshared-row'; row.innerHTML = '<span>Different row</span><button>Change</button>'; group.append(row);
    });
    assert.ok(violations([{ name: 'injected without row classes', measurement: await app.page.evaluate(measureRows) }]).some(text => text.includes('outside shared component')));
    await app.page.locator('#unshared-row').evaluate(el => el.remove());
    // Config file paths have their own inline file-ref button; mutate a shared choice control.
    for (const [selector, property, value, expected] of [
      ['.settings-row-title', 'fontSize', '21px', 'fontSize'], ['.settings-row-description', 'fontSize', '19px', 'fontSize'],
      ['.settings-row-control [data-slot="select-trigger"]', 'height', '44px', 'height'], ['.settings-row-control [data-slot="select-trigger"]', 'fontSize', '19px', 'fontSize'],
      ['.settings-row-control [data-slot="select-trigger"]', 'transform', 'translateY(7px)', 'off centre'], ['.settings-scope', 'transform', 'translateY(4px)', 'baseline'],
      ['.settings-group-heading h3', 'fontSize', '20px', 'fontSize'], ['.settings-row', 'paddingTop', '22px', 'row padding'],
    ]) {
      await app.page.locator(`.settings-page ${selector}`).filter({ visible: true }).first().evaluate((el, { property, value }) => { el.style[property] = value; }, { property, value });
      const broken = await app.page.evaluate(measureRows);
      assert.ok(violations([{ name: 'reference', measurement: base }, { name: 'injected', measurement: broken }]).some(text => text.includes(expected)), `${selector} ${property} drift was not caught`);
      await app.page.locator(`.settings-page ${selector}`).filter({ visible: true }).first().evaluate((el, property) => { el.style[property] = ''; }, property);
    }
  } finally { await app.close(); }
});

test('model disclosures audit only painted fields and catch compound alignment, size and clipping drift', async () => {
  const app = await settingsFixture();
  try {
    await visit(app.page, 'Configuration');
    const choices = app.page.getByRole('group', { name: 'Main model choices', exact: true });
    const measure = () => app.page.evaluate(measureRows);
    const closed = await measure();
    assert.equal(closed.rows.find(row => row.title === 'Main model').controls.length, 1, 'the hidden custom input is excluded');
    assert.deepEqual(violations([{ name: 'closed', measurement: closed }]), []);
    await choices.locator('summary').click();
    const expanded = await measure();
    assert.equal(expanded.rows.find(row => row.title === 'Main model').controls.length, 2, 'the opened custom input is audited');
    assert.deepEqual(violations([{ name: 'closed', measurement: closed }, { name: 'expanded', measurement: expanded }]), []);
    for (const [selector, property, value, expected] of [
      [choices, 'transform', 'translateY(7px)', 'off centre'],
      [choices.locator('[data-slot="select-trigger"]'), 'height', '44px', 'height'],
      [choices.getByRole('textbox'), 'fontSize', '19px', 'fontSize'],
      [choices.getByRole('textbox'), 'transform', 'translateY(200px)', 'clipped control'],
    ]) {
      await selector.evaluate((el, { property, value }) => { el.style[property] = value; }, { property, value });
      assert.ok(violations([{ name: 'reference', measurement: closed }, { name: 'injected', measurement: await measure() }]).some(text => text.includes(expected)), `${property} drift was not caught`);
      await selector.evaluate((el, property) => { el.style[property] = ''; }, property);
    }
    assert.deepEqual(app.errors, []);
  } finally { await app.close(); }
});
