// The 31 October preview: retain the composer anchor while edge opacity changes.
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
  const child = { id: 'anchor-agent', name: 'Anchor helper', cwd: CWD, parentThreadId: thread.id,
    source: { subAgent: { thread_spawn: { agent_path: '/root/anchor', parent_thread_id: thread.id, depth: 1 } } }, status: { type: 'idle' } };
  const f = await fixture({ running: true, threads: [thread, child], width: 1440, height: 900, colorScheme: 'dark', staticDir: process.env.ELPIS_RENDERER_OUT });
  const { page } = f;
  try {
    await f.open(thread.id);
    const working = page.locator('.turn-working'), composer = page.locator('.composer');
    const mark = working.locator('.elpis-working-mark'), rotor = mark.locator('path.elpis-working-rotor');
    const edges = mark.locator('mask .elpis-working-edge'), dot = mark.locator('.elpis-working-dot');
    await working.waitFor();
    const hideAgents = page.getByRole('button', { name: 'Hide agents panel', exact: true });
    if (await hideAgents.isVisible()) await hideAgents.click();
    const checkAnchor = async label => {
      const measured = await page.evaluate(() => {
        const work = document.querySelector('.turn-working').getBoundingClientRect();
        const box = document.querySelector('.composer').getBoundingClientRect();
        return { x: work.x - box.x, gap: box.y - work.bottom, transform: getComputedStyle(document.querySelector('.turn-working')).transform };
      });
      assert.ok(Math.abs(measured.x) < 1, `${label}: Working keeps the composer's left edge`);
      assert.ok(Math.abs(measured.gap - 18) < 1, `${label}: preview gap is 18px`);
      assert.equal(measured.transform, 'none');
    };
    for (const [width, height] of [[1440, 900], [1004, 760], [820, 760], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      await checkAnchor(String(width));
    }
    await page.getByRole('button', { name: 'Show agents panel', exact: true }).click();
    await page.locator('.team-panel').waitFor();
    await checkAnchor('agents panel open');
    await hideAgents.click();
    await page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    await page.getByRole('region', { name: 'Side panel' }).waitFor();
    await checkAnchor('side panel open');
    await page.getByRole('button', { name: 'Close side panel', exact: true }).click();
    await checkAnchor('side panel closed');
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
    let htmlPath = null;
    if (dir) {
      await fs.mkdir(dir, { recursive: true });
      const icon = await mark.boundingBox();
      const clip = { x: Math.floor(icon.x), y: Math.floor(icon.y), width: Math.ceil(icon.x + icon.width) - Math.floor(icon.x), height: Math.ceil(icon.y + icon.height) - Math.floor(icon.y) };
      const background = `data:image/png;base64,${(await page.screenshot()).toString('base64')}`;
      const images = [], started = performance.now();
      for (let index = 0; index < 48; index++) {
        const delay = started + index * (1000 / 12) - performance.now();
        if (delay > 0) await page.waitForTimeout(delay);
        const image = await page.screenshot({ clip });
        images.push({ src: `data:image/png;base64,${image.toString('base64')}`, at: performance.now() - started });
        if (index === 0 || index === 24) await page.screenshot({ path: path.join(dir, `working-frame-${index}.png`) });
      }
      const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Working animation preview</title><style>body{margin:0;background:#111317;color:#e6e0d3;font:16px system-ui}main{padding:20px;max-width:1600px;margin:auto}h1{font-size:20px;font-weight:600;margin:0 0 8px}p{margin:0 0 18px;color:#bdb9b0}.layout{display:flex;gap:20px;align-items:flex-start}.scene{position:relative;width:calc(100% - 220px);border:1px solid #444}.scene>img:first-child{display:block;width:100%;height:auto}.scene #mark{position:absolute;left:${clip.x / 1440 * 100}%;top:${clip.y / 900 * 100}%;width:${clip.width / 1440 * 100}%;height:auto}.detail{width:144px;height:144px;border:1px solid #555}.detail img{width:100%;height:100%}aside{width:190px;flex:none}small{display:block;margin-top:8px;line-height:1.4}@media(max-width:800px){.layout{flex-wrap:wrap}.scene{width:100%}}</style>
<main><h1>Working animation preview</h1><p>Same mark and color, about 1 mm higher. The enlarged view is from the same app frames.</p><div class="layout"><div class="scene"><img src="${background}" alt="Actual app preview"><img id="mark" alt=""></div><aside><div class="detail"><img id="detail" alt="Enlarged Working mark"></div><small>Working mark, enlarged</small></aside></div></main><script>const frames=${JSON.stringify(images)};const mark=document.getElementById('mark'),detail=document.getElementById('detail');let frame=-1,start=performance.now(),duration=frames.at(-1).at+1000/12;function show(index){if(index!==frame){frame=index;mark.src=detail.src=frames[index].src}}show(0);function animate(now){let at=(now-start)%duration,index=frames.findLastIndex(frame=>frame.at<=at);show(Math.max(0,index));requestAnimationFrame(animate)}if(!matchMedia('(prefers-reduced-motion: reduce)').matches)requestAnimationFrame(animate)</script></html>`;
      htmlPath = path.join(dir, 'working-preview.html');
      await fs.writeFile(htmlPath, html);
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await opacity();
    await page.waitForTimeout(200);
    assert.deepEqual(await opacity(), reduced, 'new edge motion is static with reduced motion');
    assert.ok(reduced.every(value => value === 1));
    if (htmlPath) {
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.goto(pathToFileURL(htmlPath).href);
      await page.waitForFunction(() => document.querySelector('.scene > img').naturalWidth > 0 && document.querySelector('#detail').naturalWidth > 0);
      await page.screenshot({ path: path.join(dir, 'working-preview-sheet.png') });
    }
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
