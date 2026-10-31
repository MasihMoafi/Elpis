const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fixture } = require('./parity-fixture.cjs');
const { openSettings, leaveSettings, chooseOption } = require('./controls.cjs');

const accents = ['amber', 'orange', 'blue', 'teal', 'green', 'violet', 'rose'];
const palettes = ['palette-paper', 'palette-midnight', 'palette-plum'];
const shots = process.env.ELPIS_POLISH_SHOTS;

test('the approved wordmark keeps its original Orange shading and follows every theme', async () => {
  for (const mode of ['Light', 'Dark']) {
    const f = await fixture({ width: 1280, height: 900, colorScheme: mode.toLowerCase(), staticDir: process.env.ELPIS_RENDERER_OUT });
    const { page } = f;
    try {
      await f.open('chat-a');
      const originalSvg = await fs.readFile(path.join(__dirname, `../public/branding/elpis-wordmark-amber-${mode === 'Light' ? 'light-' : ''}loop.svg`), 'utf8');
      const originalPaths = await page.evaluate(svg => [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('path')].map(element => element.getAttribute('d')), originalSvg);
      await openSettings(page);
      await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
      await page.getByRole('radiogroup', { name: 'Theme', exact: true }).getByRole('radio', { name: mode, exact: true }).click();
      const inspect = async label => {
        const mark = page.locator('.brand svg.size-wordmark');
        assert.deepEqual(await mark.locator('path').evaluateAll(elements => elements.map(element => element.getAttribute('d'))), originalPaths, `${mode}/${label}: original wordmark paths`);
        const stops = await mark.locator('linearGradient[id$="-gold"] stop').evaluateAll(elements => elements.map(stop => {
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d'); ctx.fillStyle = getComputedStyle(stop).stopColor; ctx.fillRect(0, 0, 1, 1);
          return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
        }));
        assert.equal(stops.length, mode === 'Light' ? 2 : 4, `${mode}/${label}: original stop structure`);
        assert.ok(new Set(stops.map(stop => stop.join(','))).size > 1, `${mode}/${label}: the logo retains visible shading`);
        if (label === 'orange') {
          const original = mode === 'Light' ? [[242, 169, 59], [219, 143, 34]] : [[255, 244, 214], [236, 163, 66], [237, 195, 103], [210, 171, 88]];
          for (let index = 0; index < original.length; index++) for (let channel = 0; channel < 3; channel++) {
            assert.ok(Math.abs(stops[index][channel] - original[index][channel]) <= 2, `${mode}: original Orange stop ${index} channel ${channel}`);
          }
        }
      };
      for (const accent of accents) {
        await chooseOption(page.getByLabel('Accent colour', { exact: true }), accent);
        await page.waitForFunction(value => document.documentElement.dataset.accent === value, accent);
        await inspect(accent);
      }
      for (const palette of palettes) {
        await chooseOption(page.getByLabel('Theme palette', { exact: true }), palette);
        await page.waitForFunction(() => document.documentElement.hasAttribute('data-custom-palette'));
        await inspect(palette);
      }
      await leaveSettings(page);
      if (shots) { await fs.mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `wordmark-${mode.toLowerCase()}.png`) }); }
      assert.deepEqual(f.errors, []);
    } finally { await f.close(); }
  }
});
