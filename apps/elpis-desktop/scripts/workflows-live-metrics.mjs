// Repeatable Workflows renderer measurement: one synthetic live node on the flat board, after a fixed warm-up.
// It measures this harness and every child process, including Chromium, without making a model call.
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openCanvas } = require('../tests/canvas-fixture.cjs');
const tickRate = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const graph = { name: 'Resource sample', request: 'Measure one live workflow.', nodes: [{
  id: 'sample', type: 'agent', position: { x: 300, y: 0 }, data: { title: 'Sample', instruction: 'Stay live for the measurement.', model: null, provider: null, effort: null, writeScopes: [], acceptanceCriteria: ['Measurement finishes'] },
}], edges: [] };

async function processRows() {
  const names = (await fs.readdir('/proc')).filter(name => /^\d+$/.test(name));
  const rows = [];
  await Promise.all(names.map(async name => {
    try {
      const stat = await fs.readFile(`/proc/${name}/stat`, 'utf8');
      const close = stat.lastIndexOf(')'), fields = stat.slice(close + 2).split(' ');
      const status = await fs.readFile(`/proc/${name}/status`, 'utf8');
      const ppid = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1] ?? 0);
      rows.push({ pid: Number(name), ppid, ticks: Number(fields[11]) + Number(fields[12]) });
    } catch { /* A process can end while /proc is read. */ }
  }));
  const children = new Map();
  for (const row of rows) children.set(row.ppid, [...children.get(row.ppid) ?? [], row.pid]);
  const included = new Set([process.pid]), pending = [process.pid];
  while (pending.length) for (const child of children.get(pending.pop()) ?? []) if (!included.has(child)) { included.add(child); pending.push(child); }
  return Promise.all(rows.filter(row => included.has(row.pid)).map(async row => {
    const rollup = await fs.readFile(`/proc/${row.pid}/smaps_rollup`, 'utf8').catch(() => '');
    return { ...row, pssKb: Number(/^Pss:\s+(\d+)/m.exec(rollup)?.[1] ?? 0) };
  }));
}

const fixture = await openCanvas({ graph, listed(run) {
  return { id: run.graphId, rootThreadId: run.rootThreadId, name: run.name, status: 'running', tasks: run.tasks.map(task => ({ id: task.id, title: task.title, status: 'running', assignedThreadId: null })) };
} });
try {
  const requests = [];
  fixture.page.on('request', request => { const url = new URL(request.url()); if (/^\/api\/(?:workflows|threads)/.test(url.pathname)) requests.push({ at: Date.now(), method: request.method(), path: url.pathname }); });
  await fixture.canvas.getByRole('button', { name: 'Run graph', exact: true }).click();
  await fixture.canvas.getByText(/Running.*0 of 1 done/).waitFor();
  await wait(3000);
  const samples = [];
  for (let index = 0; index < 10; index++) {
    const started = process.hrtime.bigint(), before = await processRows();
    await wait(1000);
    const after = await processRows(), elapsed = Number(process.hrtime.bigint() - started) / 1e9;
    const old = new Map(before.map(row => [row.pid, row.ticks]));
    const ticks = after.reduce((sum, row) => sum + Math.max(0, row.ticks - (old.get(row.pid) ?? row.ticks)), 0);
    samples.push({ cpuPercent: ticks / tickRate / elapsed * 100, pssMiB: after.reduce((sum, row) => sum + row.pssKb, 0) / 1024, processes: after.length });
  }
  const mean = key => samples.reduce((sum, sample) => sum + sample[key], 0) / samples.length;
  const since = requests[0]?.at ?? Date.now();
  const calls = Object.fromEntries([...new Set(requests.map(row => `${row.method} ${row.path}`))].sort().map(key => [key, requests.filter(row => `${row.method} ${row.path}` === key && row.at >= since).length]));
  process.stdout.write(`${JSON.stringify({ conditions: { view: 'Workflows / Flat', liveAgents: 1, warmupSeconds: 3, samples: 10, intervalSeconds: 1, scope: 'harness plus descendant processes' }, meanCpuPercent: mean('cpuPercent'), meanPssMiB: mean('pssMiB'), maxPssMiB: Math.max(...samples.map(sample => sample.pssMiB)), meanProcesses: mean('processes'), calls, samples }, null, 2)}\n`);
} finally {
  await fixture.close();
}
