// The real Files tree and chat links against the bridge's file reader. Measure from the
// dispatched click through a painted content frame, including layout and deferred highlighting.
import type { Page } from 'playwright-core';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs/promises') = require('node:fs/promises');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { fixture } = require('./parity-fixture.cts');
const { widenSidePanel } = require('./controls.cts');
type Sample = { name: string; paintMs: number; longestTaskMs: number; rows: number; heapBytes: number };
type Probe = { start: number; paint: number; tasks: { start: number; duration: number }[]; observer: PerformanceObserver };
type ProbeWindow = Window & { fileProbe?: Probe };

async function arm(page: Page) {
  await page.evaluate(() => {
    const target = window as ProbeWindow;
    target.fileProbe?.observer.disconnect();
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) target.fileProbe?.tasks.push({ start: entry.startTime, duration: entry.duration });
    });
    const probe = { start: 0, paint: 0, tasks: [], observer };
    target.fileProbe = probe;
    observer.observe({ type: 'longtask' });
    document.addEventListener('click', () => {
      probe.start = performance.now();
      const frame = () => {
        const text = document.querySelector<HTMLTextAreaElement>('.fe-text');
        const preview = document.querySelector('.cm-content, [aria-label="Read-only file contents"]');
        if ((text?.value || preview?.textContent) && (text ?? preview)?.getBoundingClientRect().height) {
          requestAnimationFrame(() => { probe.paint = performance.now(); });
        } else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, { capture: true, once: true });
  });
}

test('large Rust files paint within 200 ms and keep visible rows and main-thread tasks bounded', async () => {
  const progress = (phase: string) => process.env.ELPIS_PERF_REPORT ? fs.appendFile(`${process.env.ELPIS_PERF_REPORT}.log`, `${Date.now()} ${phase}\n`) : Promise.resolve();
  await progress('preparing');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-file-open-'));
  const files = await import('../bridge/files.mts');
  const sourceFiles = [
    'core/src/session/tests.rs', 'tui/src/bottom_pane/chat_composer.rs',
    'core/src/config/config_tests.rs', 'tui/src/app/tests.rs', 'core/tests/suite/code_mode.rs',
  ];
  const names: string[] = [];
  await fs.mkdir(path.join(root, 'src'));
  for (const [index, file] of sourceFiles.entries()) {
    const name = `real-${index}.rs`; names.push(name);
    await fs.copyFile(path.resolve(__dirname, '../../../codex-rs', file), path.join(root, 'src', name));
  }
  const generated = Array.from({ length: 20_000 }, (_, line) => `// Rust line ${line + 1}`).join('\n');
  await fs.writeFile(path.join(root, 'src/generated.rs'), generated); names.push('generated.rs');
  const paged = Array.from({ length: 40_000 }, (_, line) => `// Paged Rust line ${line + 1}`).join('\n');
  await fs.writeFile(path.join(root, 'src/paged.rs'), paged); names.push('paged.rs');
  const reads: number[] = [];
  const f: { page: Page; errors: string[]; open(id: string): Promise<void>; close(): Promise<void> } = await fixture({
    cwd: root, width: 1440, height: 900,
    ...(process.env.ELPIS_TEST_STATIC_DIR ? { staticDir: process.env.ELPIS_TEST_STATIC_DIR } : {}),
    chat: [['file-perf', 'Show the Rust', '`src/generated.rs:19000` and `src/paged.rs:39000`'], ['tail', 'Ready', 'Ready.']],
    routes: {
      '/api/files/dir': (_body: unknown, url: URL) => files.listDirectory(root, url.searchParams.get('dir') ?? ''),
      '/api/file': async (body: unknown, url: URL) => {
        if (body && typeof body === 'object') {
          const edit = body as { path?: unknown; content?: unknown; mtimeMs?: unknown };
          return files.writeFile(root, edit.path, edit.content, edit.mtimeMs);
        }
        const result = await files.readFile(root, url.searchParams.get('path'), {
          ...(url.searchParams.has('page') ? { page: Number(url.searchParams.get('page')) } : {}),
          ...(url.searchParams.has('line') ? { line: Number(url.searchParams.get('line')) } : {}),
          ...(url.searchParams.has('mtimeMs') ? { mtimeMs: Number(url.searchParams.get('mtimeMs')) } : {}),
        });
        reads.push(Buffer.byteLength(JSON.stringify(result))); return result;
      },
    },
  });
  await progress('fixture ready');
  const samples: Sample[] = [];
  try {
    await f.open('chat-a');
    await progress('chat ready');
    await f.page.getByRole('button', { name: 'Show side panel', exact: true }).click();
    const side = f.page.getByRole('region', { name: 'Side panel', exact: true });
    await side.getByRole('button', { name: 'New side panel tab', exact: true }).click();
    await f.page.getByRole('menuitem', { name: 'Files', exact: true }).click();
    await widenSidePanel(f.page, 700);
    const tree = side.getByRole('tree', { name: 'Project files' });
    await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
    const cdp = await f.page.context().newCDPSession(f.page);
    const trace: unknown[] = [];
    if (process.env.ELPIS_PERF_TRACE) {
      cdp.on('Tracing.dataCollected', (data: { value: unknown[] }) => trace.push(...data.value));
      await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing' });
    }
    await cdp.send('HeapProfiler.collectGarbage');
    const initial = (await cdp.send('Runtime.getHeapUsage')).usedSize;
    for (const name of names) {
      await progress(`opening ${name}`);
      // Close the previous document so the probe cannot mistake it for the new file.
      const close = side.getByRole('button', { name: /^Close .*\.rs$/ });
      if (await close.count()) await close.first().click();
      await cdp.send('HeapProfiler.collectGarbage');
      await arm(f.page);
      await tree.getByRole('treeitem', { name, exact: true }).click();
      await f.page.waitForFunction(() => (window as ProbeWindow).fileProbe?.paint);
      await f.page.waitForTimeout(500);
      await side.locator('.cm-content [class*="hljs-"]').first().waitFor();
      const measured = await f.page.evaluate(() => {
        const probe = (window as ProbeWindow).fileProbe!; probe.observer.disconnect();
        return { paintMs: probe.paint - probe.start, longestTaskMs: Math.max(0, ...probe.tasks.filter(task => task.start + task.duration >= probe.start).map(task => task.duration)), rows: document.querySelectorAll('.fe-line,.fe-gutter-line,.cm-line').length };
      });
      samples.push({ name, ...measured, heapBytes: (await cdp.send('Runtime.getHeapUsage')).usedSize - initial });
      await progress(`painted ${name}: ${JSON.stringify(samples.at(-1))}`);
    }
    await f.page.locator('.message.agent').getByRole('button', { name: 'src/paged.rs:39000', exact: true }).click();
    await f.page.waitForFunction(() => document.querySelector('.cm-line.hit')?.textContent?.includes('Paged Rust line 39000'));
    assert.equal(await side.getByRole('textbox', { name: 'Contents of src/paged.rs', exact: true }).count(), 0, 'partial source cannot accidentally overwrite the full file');
    await side.getByRole('button', { name: 'Previous page', exact: true }).click();
    await f.page.waitForFunction(() => {
      const text = document.querySelector('.cm-content')?.textContent;
      return text?.includes('Paged Rust line') && !text.includes('Paged Rust line 39000');
    });
    await f.page.locator('.message.agent').getByRole('button', { name: 'src/generated.rs:19000', exact: true }).click();
    await f.page.waitForFunction(() => {
      const line = document.querySelector('.fe-line.hit,.cm-line.hit');
      return line?.textContent?.includes('Rust line 19000');
    });
    const visible = await f.page.locator('.fe-line.hit,.cm-line.hit').first().boundingBox();
    const viewer = await side.getByRole('region', { name: 'File viewer' }).boundingBox();
    assert(visible && viewer && visible.y >= viewer.y && visible.y < viewer.y + viewer.height, 'requested line is on screen');
    const code = side.getByRole('textbox', { name: 'Contents of src/generated.rs', exact: true });
    await code.focus(); await f.page.keyboard.press('Control+End');
    await f.page.keyboard.type('\n// saved edit'); await f.page.keyboard.press('Control+s');
    await f.page.waitForFunction(() => window.__elpisHasUnsavedFiles === false);
    assert.equal(await fs.readFile(path.join(root, 'src/generated.rs'), 'utf8'), `${generated}\n// saved edit`);
    await f.page.keyboard.press('Control+z'); await f.page.keyboard.press('Control+s');
    await f.page.waitForFunction(() => window.__elpisHasUnsavedFiles === false);
    assert.equal(await fs.readFile(path.join(root, 'src/generated.rs'), 'utf8'), generated, 'undo survives saving a virtualized document');
    assert.deepEqual(f.errors, []);
    if (process.env.ELPIS_PERF_TRACE) {
      const complete = new Promise<void>(resolve => cdp.once('Tracing.tracingComplete', () => resolve()));
      await cdp.send('Tracing.end'); await complete;
      await fs.writeFile(process.env.ELPIS_PERF_TRACE, JSON.stringify({ traceEvents: trace }));
    }
    if (process.env.ELPIS_SHOTS) await f.page.screenshot({ path: path.join(process.env.ELPIS_SHOTS, 'rust-file-line-19000.png') });
    console.log(JSON.stringify({ samples, maxResponseBytes: Math.max(...reads) }));
    if (process.env.ELPIS_PERF_REPORT) await fs.writeFile(process.env.ELPIS_PERF_REPORT, JSON.stringify({ samples, maxResponseBytes: Math.max(...reads) }, null, 2));
    for (const sample of samples) {
      assert.ok(sample.paintMs <= 200, `${sample.name}: first paint ${sample.paintMs.toFixed(1)} ms exceeds 200 ms`);
      assert.ok(sample.longestTaskMs < 50, `${sample.name}: main-thread task ${sample.longestTaskMs} ms exceeds 50 ms`);
      assert.ok(sample.rows <= 240, `${sample.name}: ${sample.rows} DOM rows must depend on the viewport`);
    }
  } finally { await f.close(); await fs.rm(root, { recursive: true, force: true }); }
});
