// Tests the exported renderer and saved workspace against the installed desktop checkpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkInventory, discoverTests } from './test-gate.mjs';

// The reconstructed installed desktop and saved-workspace regression, not blanket user acceptance.
export const baselineCommit = 'bc4261027056dace49854e23104bcd5b58ed9747';
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

/** The immutable baseline owns retained tests; candidate source owns implementations. */
export async function planSuite(root = appRoot, baseline = baselineCommit) {
  const retained = JSON.parse(git(root, ['show', `${baseline}:${appPrefix}test-inventory.json`]));
  const inventory = JSON.parse(await fs.readFile(path.join(root, 'test-inventory.json'), 'utf8'));
  checkInventory(inventory, await discoverTests(root));
  const oldFiles = trackedFiles(root, baseline, [`${appPrefix}tests/`, `${appPrefix}${stateTest}`]);
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
export async function prepareBaseline(root = appRoot, baseline = baselineCommit) {
  const base = path.join(os.homedir(), '.cache/elpis-tests');
  await fs.mkdir(base, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(base, 'renderer-gate-'));
  try {
    const repository = git(root, ['rev-parse', '--show-toplevel']).trim();
    const archive = git(repository, ['archive', baseline, `${appPrefix}tests`, `${appPrefix}${stateTest}`], { encoding: 'buffer', maxBuffer: 32 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
    const retainedRoot = path.join(scratch, appPrefix);
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
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), TMPDIR: path.join(home, 'tmp'),
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

export async function runGate({ root = appRoot, evidence, baseline = baselineCommit, env = process.env } = {}) {
  assert(evidence && path.isAbsolute(evidence), 'An absolute evidence directory is required');
  await fs.mkdir(evidence, { recursive: true });
  assert.equal((await fs.readdir(evidence)).length, 0, 'Evidence directory must be empty');
  const out = path.join(root, 'out');
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Commit source changes before UI verification');
  assert.equal((await fs.readFile(path.join(out, '.commit'), 'utf8')).trim(), commit, 'Renderer commit does not match source');
  const plan = await planSuite(root, baseline);
  const before = await rendererHash(out);
  const retained = await prepareBaseline(root, baseline);
  try {
    const home = path.join(retained.scratch, 'home');
    await fs.mkdir(home);
    const files = [];
    for (const file of plan.files) files.push(await runUiFile(file, file.source === 'baseline' ? retained.root : root, evidence, home, env));
    checkResults(plan, files);
    assert.equal(await rendererHash(out), before, 'UI tests changed the renderer bytes');
    assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), commit, 'Source commit changed during UI verification');
    assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked source changed during UI verification');
    assert.equal(digest(JSON.stringify(await planSuite(root, baseline))), digest(JSON.stringify(plan)), 'UI test sources changed during verification');
    const receipt = { schemaVersion: 1, commit, baseline, planHash: digest(JSON.stringify(plan)), rendererHash: before, files };
    await fs.writeFile(path.join(out, receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(`Verified ${files.length} regression files against renderer ${before}.`);
    return receipt;
  } finally { execFileSync('gio', ['trash', retained.scratch]); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runGate({ evidence: process.argv[2] }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
