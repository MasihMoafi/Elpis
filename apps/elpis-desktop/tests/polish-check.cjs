const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const playwrightRequire = createRequire(require.resolve(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright'));
const { PNG } = require(path.join(path.dirname(playwrightRequire.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'));

// Checks painted DOM, not source strings: native markers, text, pseudo-elements, CSS and SVG triangles.
function triangleMarkers() {
  const hits = [];
  const visible = el => el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true });
  const triangles = /[\u25bc\u25b6\u25be\u25b8\u25b2\u25c0\u25c2\u25b4]/u;
  const name = el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}: ${el.textContent.trim().slice(0, 65)}`;
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el) || el.matches('script, style')) continue;
    if ([...el.childNodes].some(node => {
      if (node.nodeType !== 3 || !triangles.test(node.textContent)) return false;
      const range = document.createRange(); range.selectNodeContents(node);
      return [...range.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
    })) hits.push(`glyph ${name(el)}`);
    const style = getComputedStyle(el);
    if (el.matches('summary') && style.display === 'list-item' && /disclosure/.test(style.listStyleType)) hits.push(`native ${name(el)}`);
    if (el.matches('svg[class*="triangle"], polygon') && (el.tagName.toLowerCase() === 'svg' || (el.getAttribute('points')?.trim().split(/[\s,]+/).length === 6))) hits.push(`SVG ${name(el)}`);
    for (const pseudo of [null, '::before', '::after', '::marker']) {
      const s = pseudo ? getComputedStyle(el, pseudo) : style;
      if (pseudo && (s.content === 'none' || s.content === 'normal' || s.display === 'none')) continue;
      if (triangles.test(s.content)) hits.push(`${pseudo} glyph ${name(el)}`);
      if (/^polygon\(/.test(s.clipPath) && s.clipPath.split(',').length === 3) hits.push(`${pseudo || ''} clipped triangle ${name(el)}`);
      const borders = ['Top', 'Right', 'Bottom', 'Left'].filter(side => parseFloat(s[`border${side}Width`]) && s[`border${side}Style`] !== 'none');
      if (parseFloat(s.width) === 0 && parseFloat(s.height) === 0 && borders.length >= 3 && borders.some(side => s[`border${side}Color`] === 'rgba(0, 0, 0, 0)')) hits.push(`${pseudo || ''} border triangle ${name(el)}`);
    }
  }
  return hits;
}

async function scanDisclosures(page) {
  const hits = await page.evaluate(triangleMarkers);
  // Click each level, so lazily mounted nested disclosures are exercised too. Preserve the page's initial state.
  const opened = [];
  for (let level = 0; ; level++) {
    const closed = page.locator('details:not([open]) > summary').filter({ visible: true });
    if (!await closed.count()) break;
    assert.ok(level < 500, 'Disclosure scan must finish opening every visible disclosure');
    const summary = await closed.first().elementHandle();
    await summary.click(); opened.push(summary);
    hits.push(...await page.evaluate(triangleMarkers));
  }
  for (const summary of opened.reverse()) {
    if (await summary.isVisible()) await summary.click();
    await summary.dispose();
  }
  return [...new Set(hits)];
}

function modelSpacing() {
  return [...document.querySelectorAll('.settings-page [role="group"]')].filter(el => el.checkVisibility()).flatMap(group => {
    const summary = group.querySelector('summary');
    if (!summary?.textContent.includes('Advanced: custom model') || !summary.parentElement.open) return [];
    const hint = summary.parentElement.querySelector('p'), input = summary.parentElement.querySelector('input');
    const select = group.querySelector('[data-slot="select-trigger"]');
    const box = el => el.getBoundingClientRect();
    return [{ label: group.getAttribute('aria-label'), selectToLabel: select ? box(summary).top - box(select).bottom : null,
      labelToHint: box(hint).top - box(summary).bottom, hintToField: box(input).top - box(hint).bottom,
      rowGap: parseFloat(getComputedStyle(group.closest('.settings-row-control')).gap) }];
  });
}

// Integrate pixel coverage perpendicular to the edge, in CSS pixels. At DPR 4, antialiasing
// contributes fractional coverage rather than being mistaken for another full pixel of stroke.
async function cornerWidths(locator) {
  const paint = await locator.evaluate(el => {
    const s = getComputedStyle(el);
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d'); context.fillStyle = s.borderTopColor; context.fillRect(0, 0, 1, 1);
    return { border: [...context.getImageData(0, 0, 1, 1).data], width: parseFloat(s.borderTopWidth), top: parseFloat(s.borderTopLeftRadius), bottom: parseFloat(s.borderBottomRightRadius) };
  });
  const old = await locator.getAttribute('style');
  await locator.evaluate(el => { el.style.boxShadow = 'none'; el.style.transition = 'none'; });
  let buffer, reference;
  try {
    buffer = await locator.screenshot({ animations: 'disabled' });
    await locator.evaluate(el => {
      el.setAttribute('data-polish-native-reference', '');
      const style = document.createElement('style'); style.id = 'polish-native-reference';
      style.textContent = '[data-polish-native-reference]::before, [data-polish-native-reference]::after { content:none !important; }';
      document.head.append(style);
    });
    reference = await locator.screenshot({ animations: 'disabled' });
  } finally {
    await locator.evaluate((el, old) => {
      if (old === null) el.removeAttribute('style'); else el.setAttribute('style', old);
      el.removeAttribute('data-polish-native-reference'); document.getElementById('polish-native-reference')?.remove();
    }, old);
  }
  const rect = await locator.boundingBox();
  const measure = buffer => {
    const png = PNG.sync.read(buffer), dpr = png.width / rect.width;
    const pixel = (x, y) => [...png.data.subarray((y * png.width + x) * 4, (y * png.width + x) * 4 + 4)];
    // Sample the actual adjacent fills: translucent tray surfaces and browser colour rounding
    // otherwise turn a tiny fill difference into false extra coverage on light borders.
    const straightInside = pixel(Math.floor(png.width / 2), Math.ceil(4 * dpr));
    const border = paint.border.slice(0, 3).map((value, i) => value * paint.border[3] / 255 + straightInside[i] * (1 - paint.border[3] / 255));
    const weight = (x, y, base) => {
      const offset = (y * png.width + x) * 4;
      const delta = border.slice(0, 3).map((v, i) => v - base[i]);
      const sum = delta.reduce((n, v, i) => n + v * (png.data[offset + i] - base[i]), 0);
      const contrast = delta.reduce((n, v) => n + v * v, 0);
      return contrast ? Math.max(0, Math.min(1, sum / contrast)) : 0;
    };
    const edge = (cut, bottom) => {
      if (!cut) return null;
      const length = Math.max(2, cut * Math.SQRT2 - 6);
      const sample = normal => {
        const at = Math.floor((cut / 2 + normal / Math.SQRT2) * dpr);
        return pixel(bottom ? png.width - 1 - at : at, bottom ? png.height - 1 - at : at);
      };
      const inside = sample(3), outside = sample(-3);
      let sum = 0;
      for (let y = 0; y < Math.ceil((cut + 4) * dpr); y++) for (let x = 0; x < Math.ceil((cut + 4) * dpr); x++) {
        const X = (x + .5) / dpr, Y = (y + .5) / dpr;
        const normal = (X + Y - cut) / Math.SQRT2, tangent = (X - Y) / Math.SQRT2;
        if (Math.abs(tangent) > length / 2 || Math.abs(normal) > 3) continue;
        sum += weight(bottom ? png.width - 1 - x : x, bottom ? png.height - 1 - y : y, normal > 0 ? inside : outside);
      }
      return sum / (dpr * dpr * length);
    };
    let straight = 0;
    for (let y = 0; y < Math.ceil(4 * dpr); y++) for (let x = Math.floor(png.width / 2); x < Math.floor(png.width / 2) + Math.round(12 * dpr); x++) straight += weight(x, y, straightInside);
    return { straight: straight / (12 * dpr * dpr), top: edge(paint.top, false), bottom: edge(paint.bottom, true) };
  };
  const observed = measure(buffer), native = measure(reference);
  // Calibrate against this card's own single native stroke, at the same position, colour,
  // DPR and background. This cancels raster coverage differences between light and dark.
  return { cssWidth: paint.width, ...Object.fromEntries(['straight', 'top', 'bottom'].map(side =>
    [side, observed[side] === null || (observed[side] === 0 && native[side] === 0) ? null : observed[side] / native[side] * paint.width])), observed, native };
}

function checkWidths(measured, where) {
  for (const side of ['straight', 'top', 'bottom']) if (measured[side] !== null) assert.ok(Math.abs(measured[side] - measured.cssWidth) <= .3,
    `${where} ${side}: measured ${measured[side].toFixed(2)}px; border ${measured.cssWidth}px`);
}
async function shot(locator, directory, name) {
  await fs.mkdir(directory, { recursive: true });
  await locator.screenshot({ path: path.join(directory, `${name}.png`) });
}
module.exports = { triangleMarkers, scanDisclosures, modelSpacing, cornerWidths, checkWidths, shot };
