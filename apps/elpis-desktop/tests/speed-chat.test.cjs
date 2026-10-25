// Production renderer benchmark; the bridge supplies data only. Interactions use real clicks, keys and wheels.
// Run serially on an idle workstation. Raw samples/profiles make machine-dependent budgets reviewable.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance } = require('node:perf_hooks');
const { fixture, THREADS } = require('./parity-fixture.cjs');

const COUNT = 600; // Five items per turn, including large command output and a real diff.
const large = process.env.ELPIS_SPEED_LARGE === '1';
const AT = Date.UTC(2026, 9, 20, 8);
const prose = 'The parser preserves source positions, checks Unicode input and reports incomplete expressions. ';
const prompt = prose.repeat(45);
const reply = prose.repeat(large ? 180 : 40);
const output = large ? 'PASS src/parser.test.ts: nested expressions and Unicode offsets\n'.repeat(800)
  : 'PASS src/parser.test.ts\n' + 'PASS nested expressions and Unicode offsets\n'.repeat(200);
const patch = '@@ -1,120 +1,120 @@\n' + Array.from({ length: large ? 120 : 8 }, (_, i) => `-const previous${i} = ${i};\n+const current${i} = ${i + 1};\n`).join('');
const history = Array.from({ length: COUNT }, (_, i) => {
  const turnId = `speed-${i}`, startedAtMs = AT + i * 60_000;
  const entry = item => ({ turnId, item, startedAtMs, completedAtMs: startedAtMs + 4000 });
  return [
    entry({ id: `u-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Prompt ${i}. ${prompt}` }] }),
    entry({ id: `reason-${i}`, type: 'reasoning', summary: [prose.repeat(40)], status: 'completed' }),
    entry({ id: `cmd-${i}`, type: 'commandExecution', command: `npm test -- parser-${i}`, aggregatedOutput: output, exitCode: 0, status: 'completed' }),
    entry({ id: `diff-${i}`, type: 'fileChange', status: 'completed', changes: [{ path: `src/parser-${i}.ts`, kind: { type: 'update' }, diff: patch }] }),
    entry({ id: `a-${i}`, type: 'agentMessage', text: `Response ${i}.\n\n${reply}` }),
  ];
}).flat();
const p95 = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? 0;

test('3,000-item chat stays responsive when opening, typing, scrolling, streaming and idle', { timeout: 240_000 }, async t => {
  const label = process.env.ELPIS_SPEED_LABEL || 'current';
  const destination = process.env.ELPIS_SPEED_EVIDENCE || (process.env.ELPIS_REVIEW_SHOTS
    ? path.join(process.env.ELPIS_REVIEW_SHOTS, 'speed') : path.join(os.homedir(), '.cache/elpis-briefs/cc/speed-evidence'));
  await fs.mkdir(destination, { recursive: true });
  const thread = THREADS[0];
  const f = await fixture({ desktop: true, width: 1440, height: 900, routes: {
    '/api/threads/chat-a': () => ({ thread, data: [...history].reverse(), nextCursor: null }),
    '/api/threads/chat-a/prompts': () => ({ data: history.filter(e => e.item.type === 'userMessage').map(e => ({ turnId: e.turnId, itemId: e.item.id, text: e.item.content[0].text })) }),
  } });
  const { page, composer } = f;
  page.setDefaultTimeout(120_000);
  const cdp = await page.context().newCDPSession(page);
  const browserCdp = await page.context().browser().newBrowserCDPSession();
  await cdp.send('Performance.enable');
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  // The standard React DevTools hook observes commits without adding production instrumentation.
  await page.addInitScript(() => {
    let previous = new WeakSet();
    window.__speedCommits = [];
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(), inject(renderer) { this.renderers.set(1, renderer); return 1; },
      onCommitFiberRoot(_id, root) {
        const names = {}, seen = new WeakSet();
        const walk = fiber => {
          if (!fiber) return;
          seen.add(fiber);
          if (!previous.has(fiber) && (fiber.flags & 1) && typeof fiber.type === 'function') {
            const name = fiber.type.displayName || fiber.type.name || '(anonymous)';
            names[name] = (names[name] || 0) + 1;
          }
          walk(fiber.child); walk(fiber.sibling);
        };
        walk(root.current); previous = seen;
        window.__speedCommits.push(names);
      },
      onCommitFiberUnmount() {},
    };
  });
  await page.reload();
  await page.locator('.startup-splash').waitFor({ state: 'detached' });
  await page.evaluate(() => {
    window.__speedLong = [];
    new PerformanceObserver(list => window.__speedLong.push(...list.getEntries().map(e => ({ start: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: false });
    window.__speedInput = [];
    document.addEventListener('input', event => {
      if (event.target.getAttribute('aria-label') !== 'Message Elpis') return;
      const at = performance.now();
      requestAnimationFrame(() => requestAnimationFrame(() => window.__speedInput.push(performance.now() - at)));
    }, true);
  });
  const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
  // This fixture owns a separate browser. Sum all of its renderer processes, including worker threads;
  // CDP Performance's default TaskDuration measures wall occupancy, not process CPU time.
  const rendererCpu = async () => {
    const before = performance.now();
    const { processInfo } = await browserCdp.send('SystemInfo.getProcessInfo');
    const after = performance.now();
    const processes = processInfo.filter(process => process.type === 'renderer').map(({ id, cpuTime }) => ({ id, cpuTime })).sort((a, b) => a.id - b.id);
    assert.ok(processes.length && processes.every(process => Number.isFinite(process.cpuTime)), 'renderer CPU counters must be available');
    return { atMs: (before + after) / 2, uncertaintyMs: (after - before) / 2, processes };
  };
  const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const report = { label, large, at: new Date().toISOString(), items: history.length, bytes: Buffer.byteLength(JSON.stringify(history)), browser: page.context().browser().version(), phases: {} };
  const phase = async (name, action) => {
    const before = await metrics();
    const start = await page.evaluate(() => ({ at: performance.now(), commits: window.__speedCommits.length }));
    // CPU sampling and its eight-second restart add work to an otherwise idle renderer.
    const profiling = name !== 'idle';
    if (profiling) await cdp.send('Profiler.start');
    let snapshot = Promise.resolve();
    const timer = profiling && setTimeout(() => {
      snapshot = (async () => {
        const { profile } = await cdp.send('Profiler.stop');
        await fs.writeFile(path.join(destination, `${label}-${name}-partial.cpuprofile`), JSON.stringify(profile));
        await cdp.send('Profiler.start');
      })().catch(() => {});
    }, 8000);
    try { await action(); await paint(); }
    finally { if (timer) clearTimeout(timer); await snapshot; }
    const end = await page.evaluate(start => ({ at: performance.now(), longTasks: window.__speedLong.filter(e => e.start >= start.at), commits: window.__speedCommits.slice(start.commits) }), start);
    const after = await metrics();
    if (profiling) {
      const { profile } = await cdp.send('Profiler.stop');
      await fs.writeFile(path.join(destination, `${label}-${name}.cpuprofile`), JSON.stringify(profile));
    }
    report.phases[name] = { ms: end.at - start.at, taskOccupancyMs: (after.TaskDuration - before.TaskDuration) * 1000,
      scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000, layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
      longTasks: end.longTasks, commits: end.commits };
  };
  try {
    // Negative control: another chat is empty and cannot display this history.
    await f.open('chat-b');
    assert.equal(await page.locator('.message.agent').count(), 0);
    await phase('open', async () => {
      await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
      await page.waitForFunction(() => {
        const last = [...document.querySelectorAll('.message.agent')].at(-1);
        const root = document.querySelector('.chat-scroll');
        return last?.textContent.includes('Response 599.') && root && root.scrollHeight - root.scrollTop - root.clientHeight < 80;
      });
    });
    await t.test('opening budget', () => assert.ok(report.phases.open.ms < 2000, `open ${report.phases.open.ms.toFixed(1)} ms >= 2000 ms`));
    const type = async text => {
      await composer.focus();
      await page.evaluate(() => { window.__speedInput = []; });
      await page.keyboard.type(text, { delay: 35 });
      await paint();
      const samples = await page.evaluate(() => window.__speedInput);
      assert.equal(samples.length, text.length, 'every real input reaches a paint');
      return { samples, p95: p95(samples), max: Math.max(...samples) };
    };
    await phase('typing', async () => { report.typing = await type('measure typing latency'); });
    assert.equal(await composer.inputValue(), 'measure typing latency');
    await phase('scroll', async () => {
      await page.evaluate(() => {
        window.__speedFrames = []; window.__speedFrameAt = performance.now(); window.__speedScroll = true;
        const tick = now => { window.__speedFrames.push(now - window.__speedFrameAt); window.__speedFrameAt = now; if (window.__speedScroll) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      });
      const bounds = await page.locator('.chat-scroll').boundingBox();
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, -600); await page.waitForTimeout(35); }
      report.scroll = await page.evaluate(() => { window.__speedScroll = false; return { samples: window.__speedFrames, top: document.querySelector('.chat-scroll').scrollTop }; });
      report.scroll.p95 = p95(report.scroll.samples);
      report.scroll.dropped = report.scroll.samples.filter(ms => ms > 34).length;
    });
    // Keep the last answer visible for streaming, using the same real control a person uses.
    const bottom = page.getByRole('button', { name: 'Scroll to bottom', exact: true });
    if (await bottom.count()) await bottom.click();
    await page.waitForTimeout(400);
    await composer.fill('');
    let sent = 0;
    await phase('streaming', async () => {
      f.emit('message', { method: 'turn/started', params: { threadId: 'chat-a', turn: { id: 'speed-live' } } });
      f.emit('message', { method: 'item/started', params: { threadId: 'chat-a', turnId: 'speed-live', item: { id: 'speed-reply', type: 'agentMessage', text: '', status: 'inProgress' } } });
      const deltas = setInterval(() => { if (sent >= 80) return; sent++; f.emit('message', { method: 'item/agentMessage/delta', params: { threadId: 'chat-a', turnId: 'speed-live', itemId: 'speed-reply', delta: `chunk-${sent} ` } }); }, 20);
      try { report.streaming = await type('typing during a streaming response'); }
      finally { clearInterval(deltas); }
      const text = Array.from({ length: sent }, (_, i) => `chunk-${i + 1} `).join('');
      f.emit('message', { method: 'item/completed', params: { threadId: 'chat-a', turnId: 'speed-live', item: { id: 'speed-reply', type: 'agentMessage', text, status: 'completed' } } });
      f.emit('message', { method: 'turn/completed', params: { threadId: 'chat-a', turn: { id: 'speed-live', status: 'completed' } } });
      await page.getByText(text, { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Stop response', exact: true }).waitFor({ state: 'hidden' });
      report.streaming.deltas = sent;
      assert.equal(await composer.inputValue(), 'typing during a streaming response', 'streaming never drops typed text');
      // A delta for a different chat must not enter this transcript.
      f.emit('message', { method: 'item/agentMessage/delta', params: { threadId: 'chat-b', turnId: 'foreign', itemId: 'foreign', delta: 'FOREIGN DELTA MUST STAY ABSENT' } });
      await paint();
      assert.equal(await page.getByText('FOREIGN DELTA MUST STAY ABSENT').count(), 0);
    });
    const cpuBefore = await rendererCpu();
    await phase('idle', () => page.waitForTimeout(10_000));
    const cpuAfter = await rendererCpu();
    report.idleCpu = { before: cpuBefore, after: cpuAfter, measurement: 'SystemInfo cumulative CPU seconds, all renderer processes and threads in the private fixture browser' };
    assert.deepEqual(cpuAfter.processes.map(process => process.id), cpuBefore.processes.map(process => process.id), 'renderer processes must remain the same throughout the CPU observation');
    report.idleCpu.ms = cpuAfter.processes.reduce((total, process, index) => total + (process.cpuTime - cpuBefore.processes[index].cpuTime) * 1000, 0);
    assert.ok(report.idleCpu.ms >= 0, 'renderer CPU counters must be monotonic');
    report.idleCpu.elapsedMs = cpuAfter.atMs - cpuBefore.atMs;
    report.idleCpuPercent = report.idleCpu.ms / report.idleCpu.elapsedMs * 100;
    report.idleTaskOccupancyPercent = report.phases.idle.taskOccupancyMs / report.phases.idle.ms * 100;
    report.domNodes = (await metrics()).Nodes;
    const shots = path.join(destination, 'shots');
    await fs.mkdir(shots, { recursive: true });
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme }); await paint();
      await page.screenshot({ path: path.join(shots, `speed-${label}-${colorScheme}.png`) });
    }
    assert.deepEqual(f.errors, []);
    // Deliberately generous wall-time budgets; both input cases include a whole paint interval.
    await t.test('typing budget', () => assert.ok(report.typing.p95 < 100, `typing p95 ${report.typing.p95.toFixed(1)} ms >= 100 ms`));
    await t.test('scroll budget', () => assert.ok(report.scroll.p95 < 50, `scroll frame p95 ${report.scroll.p95.toFixed(1)} ms >= 50 ms`));
    await t.test('streaming budget', () => assert.ok(report.streaming.p95 < 120, `streaming input p95 ${report.streaming.p95.toFixed(1)} ms >= 120 ms`));
    await t.test('idle budget', () => assert.ok(report.idleCpuPercent < 2, `idle renderer CPU ${report.idleCpuPercent.toFixed(2)}% >= 2%`));
  } finally {
    await fs.writeFile(path.join(destination, `${label}.json`), JSON.stringify(report, null, 2));
    console.log('SPEED', JSON.stringify({ label, open: report.phases.open?.ms, typing: report.typing?.p95, scroll: report.scroll?.p95, streaming: report.streaming?.p95,
      idle: report.idleCpuPercent, idleCpuMs: report.idleCpu?.ms, idleWindowMs: report.idleCpu?.elapsedMs, idleTaskOccupancyPercent: report.idleTaskOccupancyPercent, nodes: report.domNodes }));
    await f.close();
  }
});
