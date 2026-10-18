// WCAG AA for every text the page shows: each element with its own text, its colour (with every ancestor's opacity) over
// the colours actually behind it (each ancestor's background, composited). Evaluated in the page; returns the failures.
function contrastFailures() {
  const parse = value => { const match = value.match(/rgba?\(([^)]+)\)/); if (!match) return null; const [r, g, b, a = 1] = match[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  // Computed colours may be oklch/oklab/color-mix results: let a canvas turn them into sRGB.
  const pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = value => { const direct = parse(value); if (direct) return direct; pen.clearRect(0, 0, 1, 1); pen.fillStyle = '#000'; pen.fillStyle = value; pen.fillRect(0, 0, 1, 1); const [r, g, b, a] = pen.getImageData(0, 0, 1, 1).data; return { r, g, b, a: a / 255 }; };
  const linear = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const luminance = c => 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const background = element => {
    const layers = [];
    for (let at = element; at; at = at.parentElement) { const colour = rgba(getComputedStyle(at).backgroundColor); if (colour.a > 0) { layers.push(colour); if (colour.a >= 1) break; } }
    let base = rgba(getComputedStyle(document.documentElement).backgroundColor); if (base.a < 1) base = over(base, { r: 255, g: 255, b: 255, a: 1 });
    for (const layer of layers.reverse()) base = over(layer, base);
    return base;
  };
  const opacity = element => { let value = 1; for (let at = element; at; at = at.parentElement) value *= Number(getComputedStyle(at).opacity); return value; };
  const failures = [];
  for (const element of document.querySelectorAll('body *')) {
    if (![...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim())) continue;
    const box = element.getBoundingClientRect(), style = getComputedStyle(element);
    if (box.width < 2 || box.height < 2 || box.bottom < 0 || box.top > innerHeight || style.visibility === 'hidden') continue;
    if (element.closest(':disabled, [aria-disabled="true"], [data-disabled], [aria-hidden="true"], svg')) continue;
    const seen = opacity(element); if (seen < 0.05) continue; // hidden until hovered: not shown, so not read
    const behind = background(element), colour = rgba(style.color), shown = over({ ...colour, a: colour.a * seen }, behind);
    const size = parseFloat(style.fontSize), large = size >= 24 || (Number(style.fontWeight) >= 700 && size >= 18.66);
    const [hi, lo] = [luminance(shown), luminance(behind)].sort((a, b) => b - a), ratio = (hi + 0.05) / (lo + 0.05);
    if (ratio < (large ? 3 : 4.5)) failures.push(`${element.tagName.toLowerCase()}.${[...element.classList].slice(0, 2).join('.')} "${element.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}:1`);
  }
  return [...new Set(failures)];
}
module.exports = { contrastFailures };
