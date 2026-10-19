import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { heldByAncestor, missingPlaywright, passRecord, records } from './gate-guards.mjs';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const tiers = ['fast', 'bridge', 'desktop', 'ui', 'opt-in'];
const ignored = new Set(['node_modules', '.next', 'out', '.tmp', '.git']);
export async function discoverTests(directory = root, relative = '') {
  const found = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory() && !ignored.has(entry.name)) found.push(...await discoverTests(directory, file));
    else if (entry.isFile()) {
      const namedTest = /\.(?:test|spec|runtime)\.[cm]?[jt]sx?$/.test(entry.name) || file === 'tests/runtime.mjs';
      const legacyTest = !namedTest && /\.[cm]?[jt]sx?$/.test(entry.name) && /(?:from\s*['"]node:test['"]|require\(['"]node:test['"]\))/.test(await fs.readFile(path.join(directory, file), 'utf8'));
      if (namedTest || legacyTest) found.push(file);
    }
  }
  return found.sort();
}

export function checkInventory(inventory, files) {
  const owners = new Map(), errors = [];
  for (const tier of Object.keys(inventory)) if (!tiers.includes(tier)) errors.push(`Unknown tier: ${tier}`);
  for (const tier of tiers) {
    if (!Array.isArray(inventory[tier])) { errors.push(`Missing tier: ${tier}`); continue; }
    for (const file of inventory[tier]) {
      if (owners.has(file)) errors.push(`Duplicate test: ${file} (${owners.get(file)}, ${tier})`);
      owners.set(file, tier);
      if (!files.includes(file)) errors.push(`Missing test file: ${file}`);
    }
  }
  for (const file of files) if (!owners.has(file)) errors.push(`Unassigned test: ${file}`);
  if (errors.length) throw new Error(errors.join('\n'));
}

async function main(args) {
  const inventory = JSON.parse(await fs.readFile(new URL('../test-inventory.json', import.meta.url), 'utf8'));
  checkInventory(inventory, await discoverTests());
  if (args[0] === '--check') {
    console.log(tiers.map(tier => `${tier}: ${inventory[tier].length}`).join(', '));
    return;
  }
  const selected = args.length ? args : tiers.filter(tier => tier !== 'opt-in');
  if (selected.some(tier => !tiers.includes(tier) || tier === 'opt-in')) throw new Error('Choose fast, bridge, desktop or ui. Run individual opt-in tests explicitly (see TESTING.md).');
  if (selected.includes('ui')) {
    const holder = heldByAncestor('/tmp/elpis-desktop-ui.lock');
    if (holder) throw new Error(`Run the gate without an outer flock: it takes /tmp/elpis-desktop-ui.lock itself for each browser file, and process ${holder} above it already holds that lock.`);
    const missing = missingPlaywright();
    if (missing) throw new Error(missing);
  }
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const start = { commit: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain', '--untracked-files=no']) === '' };
  const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-test-gate-'));
  const home = path.join(evidence, 'home');
  await fs.mkdir(home);
  const summary = { wallMs: 0, testMs: 0, files: [], evidence }, started = performance.now();
  console.log(`Test evidence: ${evidence}`);
  async function run(name, command, parameters, tier) {
    const log = path.join(evidence, name.replaceAll('/', '-') + '.tap'), output = await fs.open(log, 'w');
    const at = performance.now();
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        const child = spawn(command, parameters, { cwd: root, env: { ...process.env, ELPIS_HOME: home,
          EXCALIDRAW_LOCAL_DIR: path.join(home, 'love-spot'), EXCALIDRAW_SCREENSHOTS_DIR: path.join(home, 'Screenshots') }, stdio: ['ignore', output.fd, output.fd] });
        child.on('error', reject); child.on('exit', (status, signal) => resolve(signal ? 1 : status));
      });
    } finally { await output.close(); }
    const text = await fs.readFile(log, 'utf8');
    const testMs = Number(text.match(/^# duration_ms ([\d.]+)$/m)?.[1] ?? 0);
    summary.testMs += testMs;
    summary.files.push({ name, tier, code, testMs, wallMs: performance.now() - at, log });
    summary.wallMs = performance.now() - started;
    await fs.writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`${code === 0 ? 'PASS' : 'FAIL'} ${name} (${(testMs / 1000).toFixed(2)}s test; ${((performance.now() - at) / 1000).toFixed(2)}s wall)`);
    if (code !== 0) { console.error(text.slice(-6000)); process.exitCode = 1; }
  }
  // Fast tests import bundled prompts too; desktop/package tests consume out/.
  await run('bridge-resources', process.execPath, ['bridge/build-resources.mjs'], 'bridge');
  if (process.exitCode) return;
  let rendererBuilt = false;
  for (const tier of selected) {
    if (!rendererBuilt && (tier === 'desktop' || tier === 'ui')) {
      await run('renderer-build', 'flock', ['/tmp/elpis-desktop-build.lock', 'npm', 'run', '-s', 'build'], tier);
      if (process.exitCode) return;
      rendererBuilt = true;
    }
    if (tier === 'ui') {
      // Keep every browser file bounded and serialized with the other workstation workers.
      for (const file of inventory.ui) await run(file, 'flock', ['/tmp/elpis-desktop-ui.lock', 'timeout', '--kill-after=5s', '180s', process.execPath, '--test', '--test-timeout=180000', '--test-reporter=tap', file], tier);
    } else {
      await run(tier, process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', ...inventory[tier]], tier);
    }
  }
  console.log(`Gate: ${(summary.wallMs / 1000).toFixed(2)}s wall; ${(summary.testMs / 1000).toFixed(2)}s in test runners. ${evidence}/summary.json`);
  // A full, clean, all-green run is recorded for its commit; the desktop install refuses any commit without one.
  const record = passRecord({ start, commit: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain', '--untracked-files=no']) === '', selected, tiers, files: summary.files });
  if (record) {
    await fs.mkdir(records, { recursive: true });
    await fs.writeFile(path.join(records, `${record.commit}.json`), JSON.stringify({ ...record, evidence }, null, 2) + '\n');
    console.log(`Recorded a full pass for ${record.commit}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
