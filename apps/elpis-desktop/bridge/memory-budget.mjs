import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const KB_PER_GB = 1024 * 1024; // as `free -h` and scripts/mem-meter.py count
const METER = fileURLToPath(new URL('../scripts/mem-meter.py', import.meta.url));

/** MemAvailable of a /proc/meminfo text, in GB. */
export const memAvailableGb = meminfo => Number(/^MemAvailable:\s+(\d+) kB$/m.exec(meminfo)[1]) / KB_PER_GB;

/** The app's process tree in GB, as scripts/mem-meter.py measures it: that script is the one owner of the measure. */
export async function appTreeGb() {
  const { stdout } = await run('python3', ['-I', METER, '--json'], { timeout: 10000 });
  return JSON.parse(stdout).total.kb / KB_PER_GB;
}

let meterFailed = false;
// Outside Electron (tests, `node bridge/server.mjs`) the meter finds the installed app, not this process, so nothing of
// ours counts. A meter that cannot run counts nothing, said once: it must not stop every workflow; the cap and floor hold.
const ownTreeGb = async () => !process.versions.electron ? 0 : appTreeGb().catch(error => {
  if (!meterFailed) console.error('Memory meter unavailable; the app memory budget is not enforced:', error.message);
  meterFailed = true; return 0;
});

/** One budget for every workflow node this process runs (28 Oct: several workflows at once took the app to 10.2 GB and
 * systemd-oomd killed it): at most ELPIS_WORKER_CAP nodes at once, each started only while the machine has
 * ELPIS_WORKER_MEMORY_FLOOR_GB available and the app's tree is under ELPIS_APP_MEMORY_BUDGET_GB. */
export function createMemoryBudget({ env = process.env, available = async () => memAvailableGb(await fs.readFile('/proc/meminfo', 'utf8')),
  app = ownTreeGb, pollMs = 5000 } = {}) {
  const setting = (name, fallback) => Number(env[name]) > 0 ? Number(env[name]) : fallback;
  const cap = setting('ELPIS_WORKER_CAP', 4), floor = setting('ELPIS_WORKER_MEMORY_FLOOR_GB', 4), budget = setting('ELPIS_APP_MEMORY_BUDGET_GB', 6);
  const gb = value => `${value.toFixed(1)} GB`, waiters = new Set();
  let running = 0;
  // Ends when a slot is released, after pollMs (memory changes on its own) or on abort.
  const pause = signal => new Promise(resolve => {
    const done = () => { clearTimeout(timer); waiters.delete(done); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, pollMs); waiters.add(done); signal?.addEventListener('abort', done);
  });
  // The app's tree (a scan of /proc) is measured only once the machine meets the floor.
  const measure = async () => {
    const free = await available();
    if (free < floor) return { short: `${gb(free)} available, floor ${floor} GB` };
    const used = await app();
    return used >= budget ? { short: `the app uses ${gb(used)}, budget ${budget} GB` } : { ok: `${gb(free)} available, the app uses ${gb(used)}` };
  };
  return {
    /** Waits for a slot and enough memory and returns the slot's release. `log` hears one line when a memory wait starts
     * and one when it ends. Rejects when `signal` aborts. */
    async acquire(signal, log) {
      let waiting = false;
      for (;;) {
        signal?.throwIfAborted();
        if (running < cap) {
          const { short, ok } = await measure();
          // Another node may have taken the last slot while this one measured.
          if (!short && running < cap) {
            running++;
            if (waiting) log(`memory available: ${ok}`);
            return () => { running--; [...waiters].forEach(wake => wake()); };
          }
          if (short && !waiting) { waiting = true; log(`waiting for memory: ${short}`); }
        }
        await pause(signal);
      }
    },
  };
}

/** The bridge's one budget: every workflow run in this process shares it. */
export const workerBudget = createMemoryBudget();
