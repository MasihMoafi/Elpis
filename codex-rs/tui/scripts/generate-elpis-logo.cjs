#!/usr/bin/env node
// Regenerate: node codex-rs/tui/scripts/generate-elpis-logo.cjs [--check]
// Uses the desktop's existing sharp dependency; no runtime SVG renderer is needed.
const { readFileSync, writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createRequire } = require('node:module');
const sharp = createRequire(resolve(__dirname, '../../../apps/elpis-desktop/package.json'))('sharp');
const source = resolve(__dirname, '../../../apps/elpis-desktop/public/branding/elpis-symbol-amber-loop.svg');
const output = resolve(__dirname, '../src/frames/elpis.bin');
const columns = 60, rows = 21, tick = 50, duration = 10800;
const svg = readFileSync(source, 'utf8');
const bits = [[1, 8], [2, 16], [4, 32], [64, 128]];

(async () => {
  // Four bytes per terminal cell: braille dot mask, red, green, blue.
  const frames = Buffer.alloc((duration / tick + 1) * columns * rows * 4);
  for (let frame = 0; frame <= duration / tick; frame++) {
    const time = frame * tick / 1000;
    // Start and finish with an intact mark. The website's light sweep travels
    // across the original clipped SVG paths; its geometry remains recognizable.
    const progress = ((time - 1.05) % 6) / 1.68;
    const active = time >= 1.05 && progress >= 0 && progress < 1;
    const x = -280 + 560 * Math.max(0, Math.min(1, progress));
    const pose = svg.replace(/<style>[\s\S]*?<\/style>/, '')
      .replace('class="elpis-light"', `opacity="${active ? 1 : 0}" transform="translate(${x} 0)"`);
    const { data } = await sharp(Buffer.from(pose)).resize(columns * 2, rows * 4, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
      let mask = 0, red = 0, green = 0, blue = 0, count = 0;
      for (let dy = 0; dy < 4; dy++) for (let dx = 0; dx < 2; dx++) {
        const pixel = ((row * 4 + dy) * columns * 2 + col * 2 + dx) * 4;
        if (data[pixel + 3] < 128) continue;
        mask |= bits[dy][dx];
        red += data[pixel]; green += data[pixel + 1]; blue += data[pixel + 2]; count++;
      }
      const offset = ((frame * rows + row) * columns + col) * 4;
      frames[offset] = mask;
      if (count) {
        frames[offset + 1] = Math.round(red / count);
        frames[offset + 2] = Math.round(green / count);
        frames[offset + 3] = Math.round(blue / count);
      }
    }
  }
  if (process.argv.includes('--check')) {
    if (!readFileSync(output).equals(frames)) throw new Error('Elpis frames are stale; regenerate them');
  } else writeFileSync(output, frames);
  console.log(`${duration / tick + 1} Elpis frames, ${columns}x${rows}, ${frames.length} bytes${process.argv.includes('--check') ? ' (unchanged)' : ''}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
