const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { loveSpotFixture } = require('./love-spot-fixture.cjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('profile load, page switch, pan and note typing on private copies of real pages', {
  skip: !process.env.LOVE_SPOT_PERF_PAGES && 'Set LOVE_SPOT_PERF_PAGES to a pages directory; originals are read only', timeout: 180000,
}, async () => {
  const source = process.env.LOVE_SPOT_PERF_PAGES;
  const output = process.env.LOVE_SPOT_PERF_OUTPUT || path.join(process.env.HOME, '.cache/elpis-tests/love-polish/performance');
  await fs.mkdir(output, { recursive: true });
  const inputs = await Promise.all(['2026-10-18-morning.excalidraw', 'Current page.excalidraw'].map(async name => {
    const bytes = await fs.readFile(path.join(source, name));
    const scene = JSON.parse(bytes);
    return { name, bytes, hash: digest(bytes), elements: scene.elements.length,
      images: scene.elements.filter(e => e.type === 'image' && !e.isDeleted).length, files: Object.keys(scene.files || {}).length };
  }));
  const f = await loveSpotFixture({ prepareDirectory: async directory => {
    await fs.mkdir(path.join(directory, 'pages'), { recursive: true });
    for (const input of inputs) await fs.writeFile(path.join(directory, 'pages', input.name), input.bytes);
    await fs.writeFile(path.join(directory, 'scene.excalidraw'), inputs[0].bytes);
  } });
  try {
    const { page } = f;
    page.setDefaultTimeout(30000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      window.perfFrames = []; window.perfInputs = []; window.perfLongTasks = [];
      new PerformanceObserver(list => window.perfLongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
      for (const name of ['pointermove', 'keydown', 'input']) document.addEventListener(name, () => {
        const start = performance.now(); requestAnimationFrame(() => window.perfInputs.push(performance.now() - start));
      }, true);
      let last = 0;
      const frame = now => { if (last) window.perfFrames.push(now - last); last = now; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    const writes = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/love-spot')) writes.push(new URL(request.url()).pathname); });
    const results = { inputs: inputs.map(({ name, bytes, elements, images, files, hash }) => ({ name, bytes: bytes.length, elements, images, files, hash })), measurements: [] };
    async function measure(name, action) {
      const before = (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value;
      await page.evaluate(() => { window.perfFrames = []; window.perfInputs = []; window.perfLongTasks = []; });
      const start = performance.now();
      await action();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const ms = performance.now() - start;
      const taskMs = ((await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration').value - before) * 1000;
      const samples = await page.evaluate(() => ({ frames: window.perfFrames, inputs: window.perfInputs, longTasks: window.perfLongTasks }));
      const p95 = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] || 0;
      results.measurements.push({ name, ms, taskMs, frameP95: p95(samples.frames), inputP95: p95(samples.inputs), longTasks: samples.longTasks });
      console.log(`${name}: ${ms.toFixed(0)}ms elapsed, ${taskMs.toFixed(0)}ms renderer CPU`);
    }
    const start = performance.now();
    await page.goto(new URL('love-spot.html', f.url).href, { waitUntil: 'domcontentloaded' });
    const navigationMs = performance.now() - start;
    await page.locator('.excalidraw canvas').first().waitFor().catch(async e => {
      throw new Error(`${e.message}; url=${page.url()}; errors=${JSON.stringify(f.errors)}; body=${(await page.locator('body').innerText()).slice(0, 1000)}`);
    });
    const canvasMs = performance.now() - start;
    await page.evaluate(() => document.fonts.load('20px Excalifont'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    results.measurements.push({ name: 'load', ms: performance.now() - start, navigationMs, canvasMs });
    results.loadWrites = [...writes];
    results.loadResources = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(e => /^https?:/.test(e.name)).map(e => { const url = new URL(e.name); return { path: (url.origin === location.origin ? '' : url.origin) + url.pathname, start: e.startTime, ms: e.duration }; }));
    if (!process.env.LOVE_SPOT_PERF_LOAD_ONLY) {
      const morning = (await f.scene()).page.name;
      const switchTo = async name => {
        await page.getByRole('button', { name: 'Pages', exact: true }).click();
        await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click();
        await page.getByRole('button', { name: 'Pages', exact: true }).filter({ hasText: name }).waitFor();
      };
      await page.waitForTimeout(1800);
      await measure('switch-current', () => switchTo('Current page'));
      await page.waitForTimeout(1800);
      await measure('switch-morning', () => switchTo(morning));
      await page.waitForTimeout(1800);
      const board = await page.locator('.excalidraw').boundingBox();
      await page.mouse.click(board.x + board.width * .65, board.y + board.height * .65);
      await page.keyboard.press('Escape');
      await measure('pan', async () => {
        await page.mouse.move(board.x + board.width * .65, board.y + board.height * .65);
        await page.keyboard.down('Space'); await page.mouse.down();
        await page.mouse.move(board.x + board.width * .35, board.y + board.height * .45, { steps: 40 });
        await page.mouse.up(); await page.keyboard.up('Space');
      });
      await page.waitForTimeout(1800);
      const text = 'A private performance note with forty keys.';
      await measure('type-note', async () => {
        await page.keyboard.press('t'); await page.mouse.click(board.x + board.width * .6, board.y + board.height * .5);
        await page.locator('textarea.excalidraw-wysiwyg').waitFor();
        await page.keyboard.type(text); await page.keyboard.press('Escape');
      });
      await f.waitFor(s => s.elements.some(e => !e.isDeleted && e.text === text), 'measured note did not persist', 15000);
      await page.waitForTimeout(1800);
    }
    const { profile } = await cdp.send('Profiler.stop');
    await fs.writeFile(path.join(output, 'cpu.cpuprofile'), JSON.stringify(profile));
    await fs.writeFile(path.join(output, 'timings.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results.measurements.map(({ longTasks, ...m }) => ({ ...m, longTasks: longTasks?.length }))));
    assert.deepEqual(f.errors, []);
    for (const input of inputs) assert.equal(digest(await fs.readFile(path.join(source, input.name))), input.hash, 'original page changed');
    // A bounded CPU check detects regression without relying on machine/network wall time.
    if (process.env.LOVE_SPOT_PERF_BUDGET) {
      for (const m of results.measurements.filter(m => ['pan', 'type-note'].includes(m.name))) assert.ok(m.taskMs < Number(process.env.LOVE_SPOT_PERF_BUDGET), `${m.name} used ${m.taskMs.toFixed(0)}ms renderer CPU`);
    }
  } catch (e) {
    await f.page.screenshot({ path: path.join(output, 'failure.png') });
    await fs.writeFile(path.join(output, 'failure.txt'), `${e.stack}\n${JSON.stringify(f.errors)}\n${(await f.page.locator('body').innerText()).slice(0, 1500)}`);
    throw e;
  } finally { await f.close(); }
});
