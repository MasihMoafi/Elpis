// Preview only: do not change the accepted Working placement without Masih's selection.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');
const { fixture, CWD } = require('./parity-fixture.cjs');

test('Working edge preview keeps its anchor and animates the original hexagon', async () => {
  const thread = { id: 'chat-a', name: 'Love Spot: Working preview', cwd: CWD, model: 'sol', modelProvider: 'openai',
    status: { type: 'active' }, desktopAccess: { writable: true, mode: 'direct' } };
  const f = await fixture({ running: true, threads: [thread], width: 1440, height: 900, colorScheme: 'dark', staticDir: process.env.ELPIS_RENDERER_OUT });
  const { page } = f;
  try {
    await f.open(thread.id);
    const working = page.locator('.turn-working'), composer = page.locator('.composer');
    const mark = working.locator('.elpis-working-mark'), rotor = mark.locator('path.elpis-working-rotor');
    const edges = mark.locator('mask .elpis-working-edge'), dot = mark.locator('.elpis-working-dot');
    await working.waitFor();
    for (const [width, height] of [[1440, 900], [1004, 760], [820, 760], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      const measured = await page.evaluate(() => {
        const work = document.querySelector('.turn-working').getBoundingClientRect();
        const box = document.querySelector('.composer').getBoundingClientRect();
        return { x: work.x - box.x, gap: box.y - work.bottom, transform: getComputedStyle(document.querySelector('.turn-working')).transform };
      });
      assert.ok(Math.abs(measured.x) < 1, `${width}: Working keeps the composer's left edge`);
      assert.ok(Math.abs(measured.gap - 18) < 1, `${width}: preview gap is 18px`);
      assert.equal(measured.transform, 'none');
    }
    assert.equal(await working.count(), 1);
    const box = await mark.boundingBox();
    assert.ok(Math.abs(box.width - 18) < 1 && Math.abs(box.height - 18) < 1);
    assert.equal(await rotor.getAttribute('d'), 'M32 4 56.25 18V46L32 60 7.75 46V18Z');
    assert.equal(await rotor.evaluate(element => getComputedStyle(element).animationDuration), '4s');
    assert.equal(await dot.evaluate(element => getComputedStyle(element).animationDuration), '2s');
    assert.equal(await edges.count(), 6);
    const opacity = () => edges.evaluateAll(items => items.map(item => Number(getComputedStyle(item).opacity)));
    const first = await opacity();
    assert.ok(new Set(first.map(value => value.toFixed(2))).size >= 3, 'edges have different phases');
    await page.waitForTimeout(300);
    const second = await opacity();
    assert.ok(first.some((value, index) => Math.abs(value - second[index]) > .02), 'edge opacity changes over time');

    const dir = process.env.ELPIS_WORKING_PREVIEW_DIR;
    if (dir) {
      await fs.mkdir(dir, { recursive: true });
      const icon = await mark.boundingBox(), images = [], started = performance.now();
      for (let index = 0; index < 16; index++) {
        const delay = started + index * 250 - performance.now();
        if (delay > 0) await page.waitForTimeout(delay);
        const image = await page.screenshot();
        images.push(`data:image/png;base64,${image.toString('base64')}`);
        if (index === 0 || index === 8) await fs.writeFile(path.join(dir, `working-frame-${index}.png`), image);
      }
      const scale = 8, left = 72 - (icon.x + icon.width / 2) * scale, top = 72 - (icon.y + icon.height / 2) * scale;
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Working animation preview</title><style>body{margin:0;background:#111317;color:#e6e0d3;font:16px system-ui}main{padding:20px;max-width:1600px;margin:auto}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{margin:0 0 18px;color:#bdb9b0}.layout{display:flex;gap:20px;align-items:flex-start}.scene{max-width:calc(100% - 220px);height:auto;border:1px solid #444}.detail{width:144px;height:144px;position:relative;overflow:hidden;border:1px solid #555}.detail img{position:absolute;width:${1440 * scale}px;left:${left}px;top:${top}px;max-width:none}aside{width:190px;flex:none}small{display:block;margin-top:8px;line-height:1.4}@media(max-width:800px){.layout{flex-wrap:wrap}.scene{max-width:100%}}</style>
<main><h1>Working animation preview</h1><p>Same mark and color, about 1 mm higher. The enlarged view is from the same app frames.</p><div class="layout"><img id="scene" class="scene" alt="Actual app preview"><aside><div class="detail"><img id="detail" alt="Enlarged Working mark"></div><small>Working mark, enlarged</small></aside></div></main><script>const frames=${JSON.stringify(images)};let frame=0;const scene=document.getElementById('scene'),detail=document.getElementById('detail');function show(){scene.src=detail.src=frames[frame]}show();if(!matchMedia('(prefers-reduced-motion: reduce)').matches)setInterval(()=>{frame=(frame+1)%frames.length;show()},250)</script></html>`;
      const htmlPath = path.join(dir, 'working-preview.html');
      await fs.writeFile(htmlPath, html);
      const preview = await page.context().newPage();
      await preview.goto(pathToFileURL(htmlPath).href);
      await preview.waitForFunction(() => document.querySelector('#scene').naturalWidth > 0 && document.querySelector('#detail').naturalWidth > 0);
      await preview.screenshot({ path: path.join(dir, 'working-preview-sheet.png') });
      await preview.close();
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await opacity();
    await page.waitForTimeout(200);
    assert.deepEqual(await opacity(), reduced, 'new edge motion is static with reduced motion');
    assert.ok(reduced.every(value => value === 1));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
