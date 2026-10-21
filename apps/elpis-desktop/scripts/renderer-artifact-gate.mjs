// Tests the exported renderer and saved workspace against the installed desktop checkpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkInventory, discoverTests } from './test-gate.mjs';

// The retained UI regressions: the 21 October integration of every approved desktop fix. Move it only in a commit that
// names the request (Masih's words) that changes a retained behaviour; never to make a failing gate pass.
// 21 Oct (A121): moved from 21343157b, whose copies of 35 UI tests never passed (undefined helpers, stale fixtures),
// to the commit that repairs them case for case. Masih: "You don't need to ask me that; I'm result-oriented."
// Round 2 (f96171ccb): the merged repairs (gatefix) keep every case; the earlier baseline still had the pre-merge copies.
// Round 3 (988aad0e7): combofix scoped the dropdown helper (c23e326c8) and wf1b aimed three Workflows tests at the current UI; every case kept.
export const baselineCommit = '988aad0e78bd264c00e435be07598e79f08941e8';
// GATE10: only these audited copies need updated expectations or fixtures. Each pin names
// the commit implementing the approved behavior; all other retained tests keep their original bytes.
// Blob pins also cover the small fixture repairs in this change, without advancing the checkpoint.
export const retainedUpdates = {
  "988aad0e78bd264c00e435be07598e79f08941e8": {
    "tests/controls.cjs": {
      "blob": "612e8501e5739e60cb4baa508b899543eea99f50",
      "approval": "47a8a1712bb37dbf3df45f653d2678db9dd3a680",
      "reason": "A87/R28: one exact logo accent replaces the former amber and Send orange"
    },
    "tests/elpis-features.test.cjs": {
      "blob": "4ea61facc7acc9044ebaf5bce4ad52f900b8a98d",
      "approval": "47a8a1712bb37dbf3df45f653d2678db9dd3a680",
      "reason": "A87/R28: feature controls keep their one-click checks with the approved logo accent"
    },
    "tests/dashboard-fixture.cjs": {
      "blob": "0ddd1f09d25d8af2603dd3666789543b5a04fc28",
      "approval": "189f5bd0d80042f037527d5653edf7b0f156c7b9",
      "reason": "A132/R30: shared TUI assets and dashboard routes replace the removed desktop API"
    },
    "tests/observability.test.cjs": {
      "blob": "7a248fd62f85f7d14ac5f1d317e0f0b214e20672",
      "approval": "189f5bd0d80042f037527d5653edf7b0f156c7b9",
      "reason": "A132/R30: retain deletion/totals and complete tool/prompt disclosure against the TUI dashboard"
    },
    "tests/page-column.test.cjs": {
      "blob": "96349c75cfd27647dc4c72ec33826e7ce9f5645c",
      "approval": "189f5bd0d80042f037527d5653edf7b0f156c7b9",
      "reason": "A132/R30: Observability uses a frame; retain overflow checks for every remaining shared shell"
    },
    "tests/page-column.cjs": {
      "blob": "0b7fed1852f2513490a63ad2d28f3699bfbd54f5",
      "approval": "189f5bd0d80042f037527d5653edf7b0f156c7b9",
      "reason": "A132/R30: shared column measurements exclude the independently scrolling dashboard frame"
    },
    "tests/view-boundaries.test.cjs": {
      "blob": "eba78f5bd8e2715d70018e4562253ae41704be2f",
      "approval": "dd2ca3576700a0c448c37aed1aea3fd417b9c036",
      "reason": "A121/A70: navigation buttons have labels; inject the Ledger failure into its view, not its navigation button"
    },
    "tests/provider-usage.test.cjs": {
      "blob": "f7224436280cca61f9856afdde3b606d8687e5a5",
      "approval": "988aad0e78bd264c00e435be07598e79f08941e8",
      "reason": "Initial SSE connection refreshes accounts; retain exact request deltas for every subsequent action"
    }
  }
};
export const receiptName = '.elpis-ui-receipt.json';
const stateTest = 'desktop/state.test.cjs';
const appPrefix = 'apps/elpis-desktop/';
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (root, args, options = {}) => execFileSync('git', args, { cwd: root, encoding: 'utf8', ...options });
const blob = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const trackedFiles = (root, commit, paths) => new Map(git(root, ['ls-tree', '-r', '--full-tree', commit, '--', ...paths]).trim().split('\n').filter(Boolean).map(line => {
  const match = line.match(/^\d+ blob ([a-f0-9]+)\t(.+)$/);
  assert(match, `Unexpected tracked source entry: ${line}`);
  return [match[2].slice(appPrefix.length), match[1]];
}));

export function assertSourceCommit(root, commit) {
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), commit, 'Source HEAD changed during installation');
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked source changed during installation');
}

/** A clean working tree alone cannot detect a source mutation copied into a package and then reverted. */
export async function verifyPackagedSources({ root = appRoot, destination, commit }) {
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
  assert(manifest.schemaVersion === 1 && Array.isArray(manifest.files), 'Invalid desktop package manifest');
  const sourceIdentity = JSON.parse(git(root, ['show', `${commit}:${appPrefix}package.json`]));
  const identity = JSON.parse(await fs.readFile(path.join(destination, 'app/package.json'), 'utf8'));
  const expectedIdentity = { name: sourceIdentity.name, productName: sourceIdentity.productName || 'Elpis',
    desktopName: sourceIdentity.desktopName, version: sourceIdentity.version, main: 'desktop/main.cjs', private: true, type: 'module' };
  for (const [key, value] of Object.entries(expectedIdentity)) {
    assert.deepEqual(identity[key], value, `Packaged desktop identity differs from source commit: ${key}`);
  }
  const tracked = trackedFiles(root, commit, [appPrefix]), checked = new Set();
  for (const file of manifest.files) {
    assert(typeof file.path === 'string' && !path.isAbsolute(file.path) && !file.path.split('/').includes('..'), 'Invalid packaged path');
    const source = file.path.startsWith('app/') ? file.path.slice(4) : null;
    // Identity is checked above; package.json dependencies are generated from the bundled packages.
    if (!source || source === 'package.json' || !tracked.has(source)) continue;
    assert(!checked.has(source), `Duplicate packaged source: ${source}`);
    const packaged = path.join(destination, file.path);
    assert((await fs.lstat(packaged)).isFile(), `Packaged source must be a regular file: ${source}`);
    assert.equal(blob(await fs.readFile(packaged)), tracked.get(source), `Packaged production bytes differ from source commit: ${source}`);
    checked.add(source);
  }
  assert(checked.has('desktop/main.cjs'), 'Desktop package manifest omits its tracked entry point');
  assert(checked.has('desktop/state.cjs'), 'Desktop package manifest omits tracked desktop/state.cjs');
}

async function treeFiles(root, relative = '') {
  const files = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await treeFiles(root, name));
    else { assert(entry.isFile(), `Unexpected renderer/test symlink: ${name}`); files.push(name); }
  }
  return files;
}

export async function rendererHash(out) {
  const hash = createHash('sha256');
  for (const name of await treeFiles(out)) {
    if (name === receiptName) continue;
    const bytes = await fs.readFile(path.join(out, name));
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}

/** Resolve an immutable replacement, including a not-yet-staged repair with exactly the pinned bytes. */
async function retainedUpdate(root, name, pin) {
  assert(/^tests\/[^\0]+$/.test(name) && !name.split('/').includes('..'), `Invalid retained path: ${name}`);
  assert(/^[a-f0-9]{40}$/.test(pin.blob) && /^[a-f0-9]{40}$/.test(pin.approval) && pin.reason, `Invalid retained pin: ${name}`);
  let bytes;
  try { bytes = git(root, ['cat-file', 'blob', pin.blob], { encoding: 'buffer', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch { bytes = await fs.readFile(path.join(root, name)); }
  assert.equal(blob(bytes), pin.blob, `Changed pinned retained regression: ${name}`);
  return bytes;
}

/** The immutable baseline owns retained tests; candidate source owns implementations. */
export async function planSuite(root = appRoot, baseline = baselineCommit, updates = retainedUpdates[baseline] ?? {}) {
  const retained = JSON.parse(git(root, ['show', `${baseline}:${appPrefix}test-inventory.json`]));
  const inventory = JSON.parse(await fs.readFile(path.join(root, 'test-inventory.json'), 'utf8'));
  checkInventory(inventory, await discoverTests(root));
  const oldFiles = trackedFiles(root, baseline, [`${appPrefix}tests/`, `${appPrefix}${stateTest}`]);
  for (const [name, pin] of Object.entries(updates)) oldFiles.set(name, blob(await retainedUpdate(root, name, pin)));
  const currentFiles = new Map(await Promise.all((await treeFiles(path.join(root, 'tests'))).map(async name => [`tests/${name}`, blob(await fs.readFile(path.join(root, 'tests', name)))])));
  try { currentFiles.set(stateTest, blob(await fs.readFile(path.join(root, stateTest)))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const testNames = new Set([...Object.values(retained).flat(), ...Object.values(inventory).flat()]);
  const supportHash = files => digest(JSON.stringify([...files].filter(([name]) => !testNames.has(name)).sort()));
  const support = { baseline: supportHash(oldFiles), candidate: supportHash(currentFiles) };
  const item = (source, name, files) => {
    assert((name.startsWith('tests/') || name === stateTest) && !name.split('/').includes('..'), `Invalid regression path: ${name}`);
    assert(files.has(name), `Missing ${source} UI regression: ${name}`);
    return { source, name, blob: files.get(name) };
  };
  assert(retained.ui.length > 0 && inventory.ui.length > 0, 'The UI inventory must not be empty');
  assert(retained.desktop.includes(stateTest), 'The checkpoint must retain the saved-workspace regression');
  const retainedNames = [stateTest, ...retained.ui];
  const files = retainedNames.map(name => item('baseline', name, oldFiles));
  for (const name of [...(inventory.desktop.includes(stateTest) ? [stateTest] : []), ...inventory.ui]) {
    if (support.baseline !== support.candidate || !retainedNames.includes(name) || currentFiles.get(name) !== oldFiles.get(name)) files.push(item('candidate', name, currentFiles));
  }
  return { baseline, support, files };
}

export function passingCounts(text) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    assert.equal(matches.length, 1, `Missing or duplicate TAP ${key} count`);
    counts[key] = Number(matches[0][1]);
  }
  assert(Object.values(counts).every(Number.isSafeInteger), 'Invalid TAP counts');
  assert(counts.tests > 0 && counts.pass === counts.tests, 'UI tests must have positive passes');
  assert(['fail', 'cancelled', 'skipped', 'todo'].every(key => counts[key] === 0), 'UI tests failed, skipped, cancelled or pending');
  return counts;
}

/** Keep baseline fixtures beside their tests, but resolve production imports and out/ to the candidate. */
export async function prepareBaseline(root = appRoot, baseline = baselineCommit, updates = retainedUpdates[baseline] ?? {}) {
  // Keep screenshot sockets short, on a filesystem that supports the Trash cleanup.
  const base = path.join(os.homedir(), '.cache');
  await fs.mkdir(base, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(base, 'eu-'));
  try {
    const repository = git(root, ['rev-parse', '--show-toplevel']).trim();
    const archive = git(repository, ['archive', baseline, `${appPrefix}tests`, `${appPrefix}${stateTest}`], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
    const retainedRoot = path.join(scratch, appPrefix);
    for (const [name, pin] of Object.entries(updates)) {
      const bytes = await retainedUpdate(root, name, pin);
      await fs.mkdir(path.dirname(path.join(retainedRoot, name)), { recursive: true });
      await fs.writeFile(path.join(retainedRoot, name), bytes);
    }
    // /init and /personal compare the renderer with the candidate terminal's canonical resources.
    await fs.symlink(path.join(repository, 'codex-rs'), path.join(scratch, 'codex-rs'));
    for (const entry of await fs.readdir(root)) {
      if (entry === 'desktop') {
        for (const child of await fs.readdir(path.join(root, entry))) if (child !== 'state.test.cjs') {
          await fs.symlink(path.join(root, entry, child), path.join(retainedRoot, entry, child));
        }
      } else if (entry !== 'tests') await fs.symlink(path.join(root, entry), path.join(retainedRoot, entry));
    }
    return { scratch, root: retainedRoot };
  } catch (error) { execFileSync('gio', ['trash', scratch]); throw error; }
}

export async function runUiFile(file, root, evidence, home, env = process.env) {
  const childEnv = { ...env, HOME: home, ELPIS_HOME: path.join(home, 'elpis'), CODEX_HOME: path.join(home, 'codex'),
    ELPIS_CONFIG_DIR: path.join(home, 'elpis'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), TMPDIR: path.dirname(home),
    EXCALIDRAW_LOCAL_DIR: path.join(home, 'love-spot'), EXCALIDRAW_SCREENSHOTS_DIR: path.join(home, 'Screenshots') };
  await fs.mkdir(childEnv.TMPDIR, { recursive: true });
  delete childEnv.NODE_TEST_CONTEXT;
  console.log(`RUN ${file.source}: ${file.name}`);
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', file.name], {
    cwd: root, env: childEnv, encoding: 'utf8', timeout: 185000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  await fs.writeFile(path.join(evidence, `${file.source}-${file.name.replaceAll('/', '-')}.tap`), output);
  assert.equal(result.status, 0, `${file.source}/${file.name} failed: ${result.error?.message || output.slice(-1800)}`);
  // Node counts an empty file's wrapper as one passing test. Require actual named cases too.
  const cases = [...output.matchAll(/^# Subtest: (.+)\r?$/gm)].map(match => match[1])
    .filter(name => name !== file.name && !name.endsWith(`/${file.name}`));
  assert(cases.length > 0, `${file.name} executed no named test cases`);
  return { ...file, ...passingCounts(output), cases };
}

function checkResults(plan, files) {
  assert.equal(files.length, plan.files.length, 'UI receipt omits regression files');
  for (let i = 0; i < files.length; i++) {
    const { source, name, blob: hash } = files[i];
    assert.deepEqual({ source, name, blob: hash }, plan.files[i], 'UI receipt has stale or changed tests');
    assert(Array.isArray(files[i].cases) && files[i].cases.every(value => typeof value === 'string')
      && files[i].cases.some(value => value !== name && !value.endsWith(`/${name}`)), 'UI receipt has no named test cases');
    const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(key => [key, files[i][key]]));
    assert(Object.values(counts).every(Number.isSafeInteger), 'Invalid UI receipt counts');
    passingCounts(Object.entries(counts).map(([key, value]) => `# ${key} ${value}`).join('\n'));
  }
}

/** Exposed for a trusted installer to verify an older candidate without executing that candidate's installer. */
export async function verifyRendererReceipt({ root = appRoot, out = path.join(root, 'out'), commit = git(root, ['rev-parse', 'HEAD']).trim(), baseline = baselineCommit } = {}) {
  const receipt = JSON.parse(await fs.readFile(path.join(out, receiptName), 'utf8'));
  assert.equal(receipt.schemaVersion, 1, 'Unsupported UI receipt');
  assert.equal(receipt.commit, commit, 'UI receipt belongs to another commit');
  assert.equal((await fs.readFile(path.join(out, '.commit'), 'utf8')).trim(), commit, 'Renderer belongs to another commit');
  const plan = await planSuite(root, baseline);
  assert.equal(receipt.planHash, digest(JSON.stringify(plan)), 'UI receipt uses a different regression checkpoint');
  assert.equal(receipt.baseline, baseline, 'UI receipt uses a different baseline');
  checkResults(plan, receipt.files);
  assert.equal(receipt.rendererHash, await rendererHash(out), 'Renderer bytes changed after UI verification');
  return receipt;
}

/** Preserve the plan's order and membership; only its execution is partitioned. */
export function slicePlan(plan, shardIndex, shardCount) {
  assert(Number.isSafeInteger(shardCount) && shardCount > 0, 'Invalid UI shard count');
  assert(Number.isSafeInteger(shardIndex) && shardIndex >= 0 && shardIndex < shardCount, 'Invalid UI shard index');
  return plan.files.filter((_, index) => index % shardCount === shardIndex);
}

async function emptyEvidence(evidence) {
  assert(evidence && path.isAbsolute(evidence), 'An absolute evidence directory is required');
  await fs.mkdir(evidence, { recursive: true });
  assert.equal((await fs.readdir(evidence)).length, 0, 'Evidence directory must be empty');
}

async function gateSnapshot(root, baseline) {
  const out = path.join(root, 'out');
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Commit source changes before UI verification');
  assert.equal((await fs.readFile(path.join(out, '.commit'), 'utf8')).trim(), commit, 'Renderer commit does not match source');
  const plan = await planSuite(root, baseline);
  return { schemaVersion: 1, commit, baseline, planHash: digest(JSON.stringify(plan)), rendererHash: await rendererHash(out), plan };
}

function checkManifest(snapshot, manifest) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported UI shard plan');
  slicePlan(snapshot.plan, 0, manifest.shardCount);
  for (const key of ['commit', 'baseline', 'planHash', 'rendererHash']) {
    assert.equal(snapshot[key], manifest[key], `Prepared UI ${key} differs from source or renderer`);
  }
  assert.deepEqual(snapshot.plan, manifest.plan, 'Prepared UI plan differs from source');
}

export async function prepareGate({ root = appRoot, evidence, baseline = baselineCommit, shardCount = 6 } = {}) {
  await emptyEvidence(evidence);
  const manifest = { ...await gateSnapshot(root, baseline), shardCount };
  checkManifest(await gateSnapshot(root, baseline), manifest);
  await fs.writeFile(path.join(evidence, 'plan.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function runGate({ root = appRoot, evidence, baseline = baselineCommit, env = process.env, manifest, shardIndex } = {}) {
  await emptyEvidence(evidence);
  const snapshot = await gateSnapshot(root, baseline);
  const { plan, ...identity } = snapshot;
  if (manifest) checkManifest(snapshot, manifest);
  else assert.equal(shardIndex, undefined, 'A UI shard requires its prepared plan');
  const selected = manifest ? slicePlan(plan, shardIndex, manifest.shardCount) : plan.files;
  const retained = await prepareBaseline(root, baseline);
  try {
    const home = path.join(retained.scratch, 'home');
    await fs.mkdir(home);
    const files = [], failures = [], errors = [];
    for (const file of selected) {
      try { files.push(await runUiFile(file, file.source === 'baseline' ? retained.root : root, evidence, home, env)); }
      catch (error) {
        files.push({ ...file, error: error.message });
        failures.push(error);
        console.error(`FAIL ${file.source}: ${file.name}`);
      }
    }
    // Run every integrity check even after a file fails, and retain those diagnostics too.
    for (const check of [
      async () => assert.equal(await rendererHash(path.join(root, 'out')), identity.rendererHash, 'UI tests changed the renderer bytes'),
      () => assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), identity.commit, 'Source commit changed during UI verification'),
      () => assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked source changed during UI verification'),
      async () => assert.equal(digest(JSON.stringify(await planSuite(root, baseline))), identity.planHash, 'UI test sources changed during verification'),
    ]) {
      try { await check(); }
      catch (error) { errors.push(error.message); failures.push(error); }
    }
    if (manifest) {
      const result = { ...identity, shardIndex, shardCount: manifest.shardCount, files, errors };
      await fs.writeFile(path.join(evidence, `shard-${shardIndex}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n\n'));
      checkResults({ files: selected }, files);
      console.log(`Verified shard ${shardIndex + 1}/${manifest.shardCount}: ${files.length} regression files against renderer ${identity.rendererHash}.`);
      return result;
    }
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n\n'));
    checkResults(plan, files);
    const receipt = { ...identity, files };
    await fs.writeFile(path.join(root, 'out', receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(`Verified ${files.length} regression files against renderer ${identity.rendererHash}.`);
    return receipt;
  } finally { execFileSync('gio', ['trash', retained.scratch]); }
}

/** Only a complete set of passing shards can produce the existing installer receipt. */
export async function mergeGate({ root = appRoot, baseline = baselineCommit, manifest, shards } = {}) {
  const snapshot = await gateSnapshot(root, baseline);
  checkManifest(snapshot, manifest);
  const errors = [], seen = new Set(), byFile = new Map();
  const check = fn => { try { fn(); } catch (error) { errors.push(error); } };
  assert(Array.isArray(shards), 'UI shard results must be an array');
  for (const shard of shards) {
    check(() => assert(shard && typeof shard === 'object', 'Invalid UI shard result'));
    if (!shard || typeof shard !== 'object') continue;
    const label = `UI shard ${shard.shardIndex}`;
    check(() => assert(!seen.has(shard.shardIndex), `Duplicate UI shard ${shard.shardIndex}`));
    seen.add(shard.shardIndex);
    check(() => assert.equal(shard.schemaVersion, 1, `${label} has an unsupported schema`));
    for (const [key, description] of [['commit', 'source commit'], ['baseline', 'baseline'], ['planHash', 'plan hash'], ['rendererHash', 'renderer hash'], ['shardCount', 'shard count']]) {
      check(() => assert.equal(shard[key], manifest[key], `${label} tested a different ${description}`));
    }
    check(() => assert(Array.isArray(shard.errors), `${label} omits integrity results`));
    for (const message of Array.isArray(shard.errors) ? shard.errors : []) errors.push(new Error(`${label}: ${message}`));
    check(() => assert(Array.isArray(shard.files), `${label} omits regression results`));
    for (const file of Array.isArray(shard.files) ? shard.files : []) {
      check(() => assert(file && typeof file === 'object', `${label} has an invalid regression result`));
      if (!file || typeof file !== 'object') continue;
      const key = JSON.stringify([file.source, file.name]);
      check(() => assert(!byFile.has(key), `Duplicate UI regression ${file.source}/${file.name}`));
      byFile.set(key, file);
      if (file.error) errors.push(new Error(`${label}: ${file.source}/${file.name}: ${file.error}`));
    }
    check(() => checkResults({ files: slicePlan(manifest.plan, shard.shardIndex, manifest.shardCount) }, shard.files));
  }
  for (let index = 0; index < manifest.shardCount; index++) {
    check(() => assert(seen.has(index), `Missing UI shard ${index}`));
  }
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('\n\n'));
  const { plan, ...identity } = snapshot;
  const files = plan.files.map(file => byFile.get(JSON.stringify([file.source, file.name])));
  checkResults(plan, files);
  checkManifest(await gateSnapshot(root, baseline), manifest);
  const receipt = { ...identity, files };
  await fs.writeFile(path.join(root, 'out', receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(`Merged ${manifest.shardCount} shards: verified ${files.length} regression files against renderer ${identity.rendererHash}.`);
  return receipt;
}

async function main([mode, ...args]) {
  if (mode === '--prepare') return prepareGate({ evidence: args[0], shardCount: Number(args[1]) });
  if (mode === '--shard' || mode === '--merge') {
    const manifest = JSON.parse(await fs.readFile(args[0], 'utf8'));
    if (mode === '--shard') return runGate({ manifest, shardIndex: Number(args[1]), evidence: args[2] });
    const shards = await Promise.all((await fs.readdir(args[1])).filter(name => /^shard-\d+\.json$/.test(name))
      .sort().map(async name => JSON.parse(await fs.readFile(path.join(args[1], name), 'utf8'))));
    return mergeGate({ manifest, shards });
  }
  assert(mode && !mode.startsWith('--') && args.length === 0, 'Use <evidence> or --prepare <evidence> <count>, --shard <plan.json> <index> <evidence>, --merge <plan.json> <results>');
  return runGate({ evidence: mode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
