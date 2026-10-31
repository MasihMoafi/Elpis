const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture, THREADS } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');

const accents = ['amber', 'orange', 'blue', 'teal', 'green', 'violet', 'rose'];
const palettes = ['palette-paper', 'palette-midnight', 'palette-plum'];
const shots = process.env.ELPIS_POLISH_SHOTS;

async function expectHover(locator, formula, label) {
  await locator.hover();
  const hover = await locator.evaluate((element, value) => {
    const probe = document.createElement('span');
    probe.style.cssText = `position:absolute;background:${value}`;
    element.append(probe); const expected = getComputedStyle(probe).backgroundColor; probe.remove();
    return { actual: getComputedStyle(element).backgroundColor, expected };
  }, formula);
  assert.equal(hover.actual, hover.expected, label);
}

test('hover follows every accent and built-in palette without changing selected fills', async () => {
  for (const mode of ['Light', 'Dark']) {
    const love = { ...THREADS[0], id: 'love-hover', name: 'Love Spot: Hover' };
    const f = await fixture({ width: 1280, height: 900, colorScheme: mode.toLowerCase(), staticDir: process.env.ELPIS_RENDERER_OUT,
      threads: [...THREADS, love], storage: { 'elpis-conversation-colours-v1': JSON.stringify({ 'chat-b': 'blue' }) } });
    const { page } = f;
    try {
      await f.open('chat-a');
      const selected = page.locator('.thread-row.active');
      const beforeHover = await selected.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, bounds: element.getBoundingClientRect().toJSON() }));
      await selected.hover();
      assert.deepEqual(await selected.evaluate(element => ({ background: getComputedStyle(element).backgroundColor, bounds: element.getBoundingClientRect().toJSON() })), beforeHover, 'selected chat keeps its fill and bounds on hover');
      const formula = `color-mix(in oklab,var(--primary) ${mode === 'Light' ? 6 : 7}%,transparent)`;
      await expectHover(page.locator('.nav-list button[data-nav-page="loveSpot"]'), formula, `${mode}: Love Spot navigation`);
      await expectHover(page.locator('.thread-row[data-thread-id="love-hover"]'), formula, `${mode}: Love Spot chat`);
      const coloured = page.locator('.thread-row[data-thread-id="chat-b"][data-conversation-colour="blue"]');
      await coloured.waitFor();
      await expectHover(coloured, 'color-mix(in oklch,var(--primary) 6%,color-mix(in oklch,var(--workflow-colour) 12%,var(--sidebar)))', `${mode}: manually colored chat`);
      const plus = page.getByRole('button', { name: 'Add files and more', exact: true });
      await expectHover(plus, formula, `${mode}: shared ghost button`);
      await plus.click();
      await expectHover(page.getByRole('menuitem', { name: /^Mention/ }), formula, `${mode}: dropdown item`);
      await page.keyboard.press('Escape');
      await openSettings(page);
      await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: mode, exact: true }).click();
      const general = page.getByRole('tab', { name: 'General', exact: true });
      const appearance = page.getByRole('tab', { name: 'Appearance', exact: true });
      const inspect = async label => {
        await expectHover(general, formula, `${mode}/${label}: hover follows the active accent`);
        await expectHover(page.getByRole('button', { name: 'Create theme', exact: true }), 'color-mix(in oklab,var(--hud-face),var(--primary) 8%)', `${mode}/${label}: outline button`);
        await page.mouse.move(0, 0);
        const fill = await appearance.evaluate(element => getComputedStyle(element).backgroundColor);
        await appearance.hover();
        assert.equal(await appearance.evaluate(element => getComputedStyle(element).backgroundColor), fill, `${mode}/${label}: selected setting keeps its fill`);
      };
      for (const accent of accents) {
        await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
        await inspect(accent);
      }
      for (const palette of palettes) {
        await chooseOption(page.getByLabel('Theme palette', { exact: true }), palette);
        await inspect(palette);
      }
      await leaveSettings(page);
      if (shots) { await fs.mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `theme-polish-${mode.toLowerCase()}.png`) }); }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
