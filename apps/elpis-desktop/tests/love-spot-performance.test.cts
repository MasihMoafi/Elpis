import type { LoveSpotFixture, LoveSpotOptions, Scene } from './love-spot-test-types.mts';

type LongTask = { start: number; duration: number };
type PerfWindow = typeof window & { perfFrames: number[]; perfInputs: number[]; perfLongTasks: LongTask[] };
type Measurement = { name: string; ms: number; taskMs?: number; frameP95?: number; inputP95?: number; longTasks?: LongTask[]; navigationMs?: number; canvasMs?: number };
type Resource = { path: string; start: number; ms: number };
const test: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { performance }: typeof import('node:perf_hooks') = require('node:perf_hooks');
const { loveSpotFixture }: { loveSpotFixture(options: LoveSpotOptions): Promise<LoveSpotFixture> } = require('./love-spot-fixture.cts');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('profile load, page switch, pan and note typing on private copies of real pages', {
  skip: !process.env.LOVE_SPOT_PERF_PAGES && 'Set LOVE_SPOT_PERF_PAGES to a pages directory; originals are read only', timeout: 180000,
}, async () => {
  const source = process.env.LOVE_SPOT_PERF_PAGES;
  assert.ok(source); assert.ok(process.env.HOME);
  const output = process.env.LOVE_SPOT_PERF_OUTPUT || path.join(process.env.HOME, '.cache/elpis-tests/love-polish/performance');
  await fs.mkdir(output, { recursive: true });
  const inputs = await Promise.all(['2026-10-18-morning.excalidraw', 'Current page.excalidraw'].map(async name => {
    const bytes = await fs.readFile(path.join(source, name));
    const scene = JSON.parse(bytes.toString()) as Scene;
    return { name, bytes, hash: digest(bytes), elements: scene.elements.length,
      images: scene.elements.filter(e => e.type === 'image' && !e.isDeleted).length, files: Object.keys(scene.files || {}).length };
  }));
  const f = await loveSpotFixture({ prepareDirectory: async directory => {
    await fs.mkdir(path.join(directory, 'pages'), { recursive: true });
    for (const input of inputs) await fs.writeFile(path.join(directory, 'pages', input.name), input.bytes);
    const first = inputs[0]; assert.ok(first); await fs.writeFile(path.join(directory, 'scene.excalidraw'), first.bytes);
  } });
  try {
    const { page } = f;
    page.setDefaultTimeout(30000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      const perf = window as PerfWindow; perf.perfFrames = []; perf.perfInputs = []; perf.perfLongTasks = [];
      new PerformanceObserver(list => perf.perfLongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))).observe({ type: 'longtask', buffered: true });
      for (const name of ['pointermove', 'keydown', 'input']) document.addEventListener(name, () => {
        const start = performance.now(); requestAnimationFrame(() => perf.perfInputs.push(performance.now() - start));
      }, true);
      let last = 0;
      const frame = (now: number) => { if (last) perf.perfFrames.push(now - last); last = now; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.start');
    const writes: string[] = [];
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/love-spot')) writes.push(new URL(request.url()).pathname); });
    const results: { inputs: { name: string; bytes: number; elements: number; images: number; files: number; hash: string }[]; measurements: Measurement[]; loadWrites?: string[]; loadResources?: Resource[] } = { inputs: inputs.map(({ name, bytes, elements, images, files, hash }) => ({ name, bytes: bytes.length, elements, images, files, hash })), measurements: [] };
    async function measure(name: string, action: () => Promise<void>) {
      const beforeMetric = (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration'); assert.ok(beforeMetric); const before = beforeMetric.value;
      await page.evaluate(() => { const perf = window as PerfWindow; perf.perfFrames = []; perf.perfInputs = []; perf.perfLongTasks = []; });
      const start = performance.now();
      await action();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const ms = performance.now() - start;
      const afterMetric = (await cdp.send('Performance.getMetrics')).metrics.find(m => m.name === 'TaskDuration'); assert.ok(afterMetric); const taskMs = (afterMetric.value - before) * 1000;
      const samples = await page.evaluate(() => ({ frames: (window as PerfWindow).perfFrames, inputs: (window as PerfWindow).perfInputs, longTasks: (window as PerfWindow).perfLongTasks }));
      const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] || 0;
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
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    results.measurements.push({ name: 'load', ms: performance.now() - start, navigationMs, canvasMs });
    results.loadWrites = [...writes];
    results.loadResources = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(e => /^https?:/.test(e.name)).map(e => { const url = new URL(e.name); return { path: (url.origin === location.origin ? '' : url.origin) + url.pathname, start: e.startTime, ms: e.duration }; }));
    if (!process.env.LOVE_SPOT_PERF_LOAD_ONLY) {
      const currentPage = (await f.scene()).page; assert.ok(currentPage); const morning = currentPage.name;
      const switchTo = async (name: string) => {
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
      assert.ok(board);
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
      for (const m of results.measurements.filter(m => ['pan', 'type-note'].includes(m.name))) { assert.ok(m.taskMs !== undefined); assert.ok(m.taskMs < Number(process.env.LOVE_SPOT_PERF_BUDGET), `${m.name} used ${m.taskMs.toFixed(0)}ms renderer CPU`); }
    }
  } catch (e) {
    await f.page.screenshot({ path: path.join(output, 'failure.png') });
    await fs.writeFile(path.join(output, 'failure.txt'), `${e instanceof Error ? e.stack : String(e)}\n${JSON.stringify(f.errors)}\n${(await f.page.locator('body').innerText()).slice(0, 1500)}`);
    throw e;
  } finally { await f.close(); }
});
