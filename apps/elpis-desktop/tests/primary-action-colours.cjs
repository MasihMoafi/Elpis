// Shared by the renderer regression and the packaged-app check. All states use real input.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { LOGO_ACCENT } = require('./controls.cjs');
const LOGO_RGB = LOGO_ACCENT.slice(1).match(/../g).map(value => parseInt(value, 16));

function hue([r, g, b]) {
  const delta = Math.max(r, g, b) - Math.min(r, g, b);
  return delta && r >= g && r >= b ? 60 * (g - b) / delta : null;
}

async function colours(page, theme, directory, accent = 'amber') {
  const composer = page.getByRole('textbox', { name: 'Message Elpis', exact: true });
  const send = page.locator('.send-button');
  const measurements = [];
  assert.equal(await page.locator('html').evaluate(element => element.classList.contains('dark')), theme === 'dark', 'actual theme');
  if (directory) await fs.mkdir(directory, { recursive: true });
  async function record(state) {
    // Include the end of the shared Button transition, not an intermediate frame.
    await page.waitForTimeout(250);
    const result = await send.evaluate(element => {
      const style = getComputedStyle(element), root = getComputedStyle(document.documentElement);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true, colorType: 'float16' });
      const pixel = paint => {
        ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = paint; ctx.fillRect(0, 0, 1, 1);
        // Keep the hue of faint tints measurable without 8-bit rounding shifting it by several degrees.
        return [...ctx.getImageData(0, 0, 1, 1, { pixelFormat: 'rgba-float16' }).data].map(value => value * 255);
      };
      const tokens = {};
      const probe = document.createElement('span'); document.body.append(probe);
      for (const token of ['--primary-action', '--primary-action-hover', '--primary-action-pressed', '--primary', '--gold', '--accent-mark', '--ring', '--border', '--hairline', '--hover', '--selected', '--hud-edge', '--hud-face', '--hud-face-hover']) {
        if (!root.getPropertyValue(token).trim()) continue;
        probe.style.color = `var(${token})`;
        tokens[token] = pixel(getComputedStyle(probe).color);
      }
      probe.remove();
      const paints = {};
      for (const [name, paint] of [['Send border', style.borderTopColor], ['composer edge', getComputedStyle(document.querySelector('.composer')).borderTopColor]]) {
        paints[name] = pixel(paint);
      }
      for (const [index, paint] of [...style.boxShadow.matchAll(/(?:rgba?|color|oklab|oklch)\([^()]*\)/g)].entries()) {
        paints[`Send shadow ${index}`] = pixel(paint[0]);
      }
      return { background: style.backgroundColor, rgba: pixel(style.backgroundColor), foreground: style.color, foregroundRgba: pixel(style.color),
        border: style.borderColor, shadow: style.boxShadow, opacity: style.opacity, disabled: element.disabled,
        hover: element.matches(':hover'), pressed: element.matches(':active'), focus: element.matches(':focus-visible'), tokens, paints };
    });
    measurements.push({ theme, accent, state, ...result });
    if (directory) await page.screenshot({ path: path.join(directory, `${theme}-${accent}-${state}.png`) });
  }
  await composer.fill('A87 logo colour check');
  await composer.focus(); await page.mouse.move(0, 0);
  await page.waitForFunction(() => !document.querySelector('.send-button')?.disabled);
  assert.equal(await send.isEnabled(), true);
  await record('rest');
  await send.hover(); await record('hover');
  await page.mouse.down();
  try { await record('pressed'); }
  finally { await page.mouse.move(0, 0); await page.mouse.up(); }
  await composer.focus();
  for (let tabs = 0; tabs < 30; tabs++) {
    await page.keyboard.press('Tab');
    if (await send.evaluate(element => document.activeElement === element)) break;
  }
  assert.equal(await send.evaluate(element => document.activeElement === element), true, 'Tab reaches Send');
  await record('focus');
  // Empty input is the actual disabled condition; leave it under the pointer too.
  await composer.fill('');
  assert.equal(await send.isDisabled(), true);
  const box = await send.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await record('disabled');
  return measurements;
}

async function evidence(directory, measurements) {
  if (directory) await fs.writeFile(path.join(directory, 'colours.json'), JSON.stringify(measurements, null, 2) + '\n');
}

function assertColours(measurements) {
  assert.equal(hue([179, 71, 0]) >= 32, false, '#b34700 must fail');
  assert.ok(Math.abs(hue([255, 138, 0]) - hue(LOGO_RGB)) > .7, 'the former #ff8a00 Send colour must fail');
  for (const theme of ['light', 'dark']) for (const accent of ['amber', 'orange']) {
    assert.deepEqual(measurements.filter(row => row.theme === theme && row.accent === accent).map(row => row.state), ['rest', 'hover', 'pressed', 'focus', 'disabled'], `${theme} ${accent}: every state was measured`);
  }
  const failures = [];
  for (const row of measurements) {
    const label = `${row.theme} ${row.accent} ${row.state}`;
    for (const [name, rgba] of [['Send', row.rgba], ...Object.entries(row.tokens), ...Object.entries(row.paints)]) {
      const [r, g, b, alpha] = rgba, chroma = Math.max(r, g, b) - Math.min(r, g, b);
      // Neutral surfaces may remain neutral; any visible accent must retain the approved hue.
      if (name !== 'Send' && (chroma < 8 || alpha < 12)) continue;
      const value = hue(rgba);
      if (value === null || Math.abs(value - hue(LOGO_RGB)) > 0.7) failures.push(`${label} ${name}: ${rgba.map(Math.round)} hue=${value}`);
    }
    const tint = row.state === 'hover' ? .08 : row.state === 'pressed' ? .16 : 0;
    const expected = [...LOGO_RGB.map(value => Math.round(value + (255 - value) * tint)), 255];
    if (row.rgba.some((value, index) => Math.abs(value - expected[index]) > 0.6)) failures.push(`${label}: expected logo ${LOGO_ACCENT} with ${tint * 100}% white, got ${row.rgba}`);
    for (const name of ['--primary', '--gold', '--accent-mark', '--ring', '--primary-action']) {
      if (row.tokens[name].some((value, index) => Math.abs(value - [...LOGO_RGB, 255][index]) > 0.2)) failures.push(`${label} ${name}: must match the logo ${LOGO_ACCENT}`);
    }
    const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const [lighter, darker] = [luminance(row.rgba), luminance(row.foregroundRgba)].sort((a, b) => b - a);
    if (!row.disabled && (lighter + .05) / (darker + .05) < 4.5) failures.push(`${label}: Send text contrast is below 4.5:1`);
    if (row.state === 'hover' && !row.hover) failures.push(`${label}: pointer did not enter Send`);
    if (row.state === 'pressed' && !row.pressed) failures.push(`${label}: mouse was not held down`);
    if (row.state === 'focus' && !row.focus) failures.push(`${label}: keyboard focus was not visible`);
    if (row.state === 'focus' && row.shadow === 'none') failures.push(`${label}: no keyboard focus ring`);
    if (row.state === 'disabled' && !row.disabled) failures.push(`${label}: empty Send was not disabled`);
  }
  assert.deepEqual(failures, [], `primary action and shared accents must use the logo's ${LOGO_ACCENT}`);
}

module.exports = { colours, evidence, assertColours };
