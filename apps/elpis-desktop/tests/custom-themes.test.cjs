// User-authored themes run through the actual Appearance controls and shared renderer tokens.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');

async function appearance(page) {
  await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  return page.getByRole('tabpanel', { name: 'Appearance', exact: true });
}

const token = (page, name) => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
const waitToken = (page, name, value) => page.waitForFunction(({ name, value }) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() === value, { name, value });

test('all visible Elpis wordmarks follow the chosen accent in light and dark', async t => {
  const fs = require('node:fs/promises');
  const evidence = process.env.ELPIS_THEME_SHOTS;
  if (evidence) await fs.mkdir(evidence, { recursive: true });
  const f = await fixture(), { page } = f; t.after(f.close);
  await f.open('chat-a');
  for (const mode of ['Light', 'Dark']) {
    await appearance(page);
    await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: mode, exact: true }).click();
    for (const accent of ['amber', 'blue', 'teal', 'green', 'violet', 'rose', 'orange']) {
      await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
      await page.waitForFunction(value => document.documentElement.dataset.accent === value, accent);
      await leaveSettings(page);
      const color = await page.locator('.brand-home svg stop[stop-color="var(--primary)"]').first().evaluate(stop => getComputedStyle(stop).stopColor);
      const expected = await page.evaluate(() => {
        const el = document.createElement('span'); el.style.color = 'var(--primary)';
        document.body.append(el); const value = getComputedStyle(el).color; el.remove(); return value;
      });
      assert.equal(color, expected, `${mode} ${accent}: wordmark uses the selected accent`);
      assert.ok((await page.locator('.brand-home').boundingBox()).width > 60, 'logo retains its width beside the sidebar toggle');
      if (evidence && accent === 'teal') {
        await page.waitForTimeout(900); // the approved logo's entrance animation
        await page.screenshot({ path: `${evidence}/teal-${mode.toLowerCase()}.png` });
      }
      await appearance(page);
    }
    await leaveSettings(page);
  }
});

async function typeValue(page, label, value) {
  const input = page.getByLabel(label, { exact: true });
  await input.click();
  await input.press('Control+A');
  await page.keyboard.type(value);
}

test('custom palettes can author light and dark colours, switch, and persist', async t => {
  const usageLimit = { limitId: 'critical', limitName: 'ChatGPT', planType: null, primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: null }, secondary: null, reached: null };
  const f = await fixture({ routes: { '/api/providers': () => ({
    openai: { auth: { state: 'signedIn' }, usage: [usageLimit], usageError: null },
    claude: { state: 'notConnected', models: [], usage: [] }, gemini: { state: 'notConnected', models: [], usage: [] }, openrouter: [],
  }) } }), { page } = f; t.after(f.close);
  await f.open('chat-a');
  await appearance(page);
  assert.equal(await token(page, '--destructive'), '#b5102e');
  await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Dark', exact: true }).click();
  await waitToken(page, '--destructive', '#ff2147');
  assert.equal(await token(page, '--destructive'), '#ff2147');
  await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Light', exact: true }).click();
  await waitToken(page, '--destructive', '#b5102e');

  await page.getByRole('button', { name: 'Create theme', exact: true }).click();
  const palette = page.getByLabel('Theme palette', { exact: true });
  const customId = await palette.getAttribute('data-value');
  assert.ok(customId && customId !== 'elpis');

  const colors = [
    ['Light Background hex', '#f4e2e6'], ['Light Text hex', '#252524'], ['Light Muted text hex', '#636361'],
    ['Light Surface hex', '#fff9fa'], ['Light Sidebar hex', '#eee1e5'], ['Light Accent hex', '#9c1732'],
    ['Light Accent text hex', '#ffffff'], ['Light Critical red hex', '#a10e2b'], ['Light Warning hex', '#76680a'],
    ['Light Success hex', '#16703f'], ['Light Context hex', '#66760f'],
    ['Dark Background hex', '#171018'], ['Dark Text hex', '#e6e0d3'], ['Dark Muted text hex', '#9c9587'],
    ['Dark Surface hex', '#211821'], ['Dark Sidebar hex', '#100c12'], ['Dark Accent hex', '#ff5577'],
    ['Dark Accent text hex', '#0a0b0d'], ['Dark Critical red hex', '#ff1744'], ['Dark Warning hex', '#f2c26b'],
    ['Dark Success hex', '#5fd3a0'], ['Dark Context hex', '#cfd46e'],
  ];
  await typeValue(page, 'Theme name', 'Crimson Lab');
  for (const [label, value] of colors) await typeValue(page, label, value);
  await page.getByRole('button', { name: 'Save theme', exact: true }).click();
  await waitToken(page, '--canvas', '#f4e2e6');

  for (const [name, value] of [['--canvas', '#f4e2e6'], ['--foreground', '#252524'], ['--muted-foreground', '#636361'],
    ['--card', '#fff9fa'], ['--composer', '#fff9fa'], ['--sidebar', '#eee1e5'], ['--accent-light', '#9c1732'],
    ['--primary-foreground', '#ffffff'], ['--destructive', '#a10e2b'], ['--warning', '#76680a'], ['--success', '#16703f'], ['--context', '#66760f']])
    assert.equal(await token(page, name), value, `light ${name}`);
  await leaveSettings(page);
  const criticalBar = page.locator('.usage-summary .usage-row.critical i');
  await criticalBar.waitFor();
  assert.match(await criticalBar.evaluate(element => getComputedStyle(element).backgroundImage), /rgb\(161, 14, 43\)/);
  await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: 'Dark', exact: true }).click();
  await waitToken(page, '--canvas', '#171018');
  for (const [name, value] of [['--canvas', '#171018'], ['--foreground', '#e6e0d3'], ['--muted-foreground', '#9c9587'],
    ['--card', '#211821'], ['--composer', '#211821'], ['--sidebar', '#100c12'], ['--accent-dark', '#ff5577'],
    ['--primary-foreground', '#0a0b0d'], ['--destructive', '#ff1744'], ['--warning', '#f2c26b'], ['--success', '#5fd3a0'], ['--context', '#cfd46e']])
    assert.equal(await token(page, name), value, `dark ${name}`);
  await leaveSettings(page);
  assert.match(await criticalBar.evaluate(element => getComputedStyle(element).backgroundImage), /rgb\(255, 23, 68\)/);
  await openSettings(page);
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();

  await page.reload();
  await appearance(page);
  assert.equal(await page.getByLabel('Theme palette', { exact: true }).getAttribute('data-value'), customId);
  await waitToken(page, '--canvas', '#171018');
  assert.equal(await token(page, '--canvas'), '#171018');
  assert.equal(await page.getByLabel('Theme name', { exact: true }).inputValue(), 'Crimson Lab');

  await chooseOption(page.getByLabel('Theme palette', { exact: true }), 'elpis');
  await waitToken(page, '--canvas', '#0a0b0d');
  assert.equal(await token(page, '--canvas'), '#0a0b0d');
  await chooseOption(page.getByLabel('Theme palette', { exact: true }), customId);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Delete theme', exact: true }).click();
  assert.equal(await page.getByLabel('Theme palette', { exact: true }).getAttribute('data-value'), 'elpis');
  assert.equal(await token(page, '--canvas'), '#0a0b0d');
  assert.deepEqual(f.errors, []);
});
