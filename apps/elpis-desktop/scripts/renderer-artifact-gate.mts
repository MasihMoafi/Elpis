import { stateTests, isStateTest, appPrefix, appRoot, digest, git, gitBuffer, trackedFiles, retiredAtBaseline, rendererHash, retainedUpdate, planSuite } from './renderer-artifact-sources.mts';
export { assertSourceCommit, verifyPackagedSources, rendererHash, planSuite } from './renderer-artifact-sources.mts'
import { passingCounts, checkResults, slicePlan, checkManifest } from './renderer-evidence-validation.mts';
export { passingCounts, slicePlan } from './renderer-evidence-validation.mts'
import type { PlanFile, FileResult, Snapshot, Manifest, Shard } from './renderer-evidence-types.mts';
import { baselineCommit, retainedUpdates } from './renderer-evidence-pins.mts';
import type { Pin } from './renderer-evidence-pins.mts';
export { baselineCommit, retainedUpdates, retiredPaths } from './renderer-evidence-pins.mts'
// Tests the exported renderer and saved workspace against the installed desktop checkpoint.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export { receiptName } from './renderer-evidence-validation.mts';
import { receiptName } from './renderer-evidence-validation.mts';

/** Keep baseline fixtures beside their tests, but resolve production imports and out/ to the candidate. */
export async function prepareBaseline(root = appRoot, baseline = baselineCommit, updates: Record<string, Pin> = retainedUpdates[baseline] ?? {}) {
  // Keep screenshot sockets short, on a filesystem that supports the Trash cleanup.
  const base = process.env.XDG_CACHE_HOME || os.tmpdir();
  await fs.mkdir(base, { recursive: true });
  const scratch = await fs.mkdtemp(path.join(base, 'eu-'));
  try {
    const repository = git(root, ['rev-parse', '--show-toplevel']).trim();
    const kept = [...trackedFiles(root, baseline, stateTests.map(name => appPrefix + name)).keys()].map(name => appPrefix + name);
    const archive = gitBuffer(repository, ['archive', baseline, `${appPrefix}tests`, ...kept], { maxBuffer: 32 * 1024 * 1024 });
    execFileSync('tar', ['-x', '-C', scratch], { input: archive });
    const retainedRoot = path.join(scratch, appPrefix);
    for (const [name, pin] of Object.entries(updates)) {
      const bytes = await retainedUpdate(root, name, pin);
      await fs.mkdir(path.dirname(path.join(retainedRoot, name)), { recursive: true });
      await fs.writeFile(path.join(retainedRoot, name), bytes);
    }
    const baselineFiles = trackedFiles(root, baseline, [`${appPrefix}tests/`]);
    for (const name of retiredAtBaseline(baseline, baselineFiles)) execFileSync('gio', ['trash', path.join(retainedRoot, name)]);
    // /init and /personal compare the renderer with the candidate terminal's canonical resources.
    await fs.symlink(path.join(repository, 'codex-rs'), path.join(scratch, 'codex-rs'));
    for (const entry of await fs.readdir(root)) {
      if (entry === 'desktop') {
        for (const child of await fs.readdir(path.join(root, entry))) if (!isStateTest(`desktop/${child}`)) {
          await fs.symlink(path.join(root, entry, child), path.join(retainedRoot, entry, child));
        }
      } else if (entry !== 'tests') await fs.symlink(path.join(root, entry), path.join(retainedRoot, entry));
    }
    return { scratch, root: retainedRoot };
  } catch (error) { execFileSync('gio', ['trash', scratch]); throw error; }
}

export async function runUiFile(file: PlanFile, root: string, evidence: string, home: string, env: NodeJS.ProcessEnv = process.env): Promise<FileResult> {
  const tmpDir = path.dirname(home);
  const childEnv: NodeJS.ProcessEnv = { ...env, HOME: home, ELPIS_HOME: path.join(home, 'elpis'), CODEX_HOME: path.join(home, 'codex'),
    ELPIS_CONFIG_DIR: path.join(home, 'elpis'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'), XDG_STATE_HOME: path.join(home, '.local/state'), TMPDIR: tmpDir,
    EXCALIDRAW_LOCAL_DIR: path.join(home, 'love-spot'), EXCALIDRAW_SCREENSHOTS_DIR: path.join(home, 'Screenshots') };
  if (env.ELPIS_REVIEW_SHOTS) childEnv.ELPIS_REVIEW_SHOTS = path.join(env.ELPIS_REVIEW_SHOTS, file.source);
  await fs.mkdir(tmpDir, { recursive: true });
  delete childEnv.NODE_TEST_CONTEXT;
  console.log(`RUN ${file.source}: ${file.name}`);
  const result = spawnSync(process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', file.name], {
    cwd: root, env: childEnv, encoding: 'utf8', timeout: 185000, maxBuffer: 8 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  await fs.writeFile(path.join(evidence, `${file.source}-${file.name.replaceAll('/', '-')}.tap`), output);
  assert.equal(result.status, 0, `${file.source}/${file.name} failed: ${result.error?.message || output.slice(-1800)}`);
  // Node counts an empty file's wrapper as one passing test. Require actual named cases too.
  const cases = [...output.matchAll(/^# Subtest: (.+)\r?$/gm)].map(match => { assert(match[1]); return match[1]; })
    .filter(name => name !== file.name && !name.endsWith(`/${file.name}`));
  assert(cases.length > 0, `${file.name} executed no named test cases`);
  return { ...file, ...passingCounts(output), cases };
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

async function emptyEvidence(evidence: string | undefined): Promise<string> {
  assert(evidence && path.isAbsolute(evidence), 'An absolute evidence directory is required');
  await fs.mkdir(evidence, { recursive: true });
  assert.equal((await fs.readdir(evidence)).length, 0, 'Evidence directory must be empty');
  return evidence;
}

async function gateSnapshot(root: string, baseline: string): Promise<Snapshot> {
  const out = path.join(root, 'out');
  const commit = git(root, ['rev-parse', 'HEAD']).trim();
  assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Commit source changes before UI verification');
  assert.equal((await fs.readFile(path.join(out, '.commit'), 'utf8')).trim(), commit, 'Renderer commit does not match source');
  const plan = await planSuite(root, baseline);
  return { schemaVersion: 1, commit, baseline, planHash: digest(JSON.stringify(plan)), rendererHash: await rendererHash(out), plan };
}

export async function prepareGate({ root = appRoot, evidence, baseline = baselineCommit, shardCount = 6 }: { root?: string; evidence?: string | undefined; baseline?: string; shardCount?: number } = {}) {
  const directory = await emptyEvidence(evidence);
  const manifest = { ...await gateSnapshot(root, baseline), shardCount };
  checkManifest(await gateSnapshot(root, baseline), manifest);
  await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  return manifest;
}

export async function runGate({ root = appRoot, evidence, baseline = baselineCommit, env = process.env, manifest, shardIndex }: { root?: string; evidence?: string | undefined; baseline?: string; env?: NodeJS.ProcessEnv; manifest?: Manifest; shardIndex?: number } = {}) {
  const directory = await emptyEvidence(evidence);
  const snapshot = await gateSnapshot(root, baseline);
  const { plan, ...identity } = snapshot;
  if (manifest) { checkManifest(snapshot, manifest); assert(shardIndex !== undefined, 'Invalid UI shard index'); }
  else assert.equal(shardIndex, undefined, 'A UI shard requires its prepared plan');
  const selected = manifest && shardIndex !== undefined ? slicePlan(plan, shardIndex, manifest.shardCount) : plan.files;
  const retained = await prepareBaseline(root, baseline);
  try {
    const home = path.join(retained.scratch, 'home');
    await fs.mkdir(home);
    const files: FileResult[] = [], failures: unknown[] = [], errors: string[] = [];
    for (const file of selected) {
      try { files.push(await runUiFile(file, file.source === 'baseline' ? retained.root : root, directory, home, env)); }
      catch (error) {
        files.push({ ...file, error: errorMessage(error) });
        failures.push(error);
        console.error(`FAIL ${file.source}: ${file.name}`);
      }
    }
    // Run every integrity check even after a file fails, and retain those diagnostics too.
    for (const check of [
      async () => assert.equal(await rendererHash(path.join(root, 'out')), identity.rendererHash, 'UI tests changed the renderer bytes'),
      () => Promise.resolve(assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), identity.commit, 'Source commit changed during UI verification')),
      () => Promise.resolve(assert.equal(git(root, ['status', '--porcelain', '--untracked-files=no']).trim(), '', 'Tracked source changed during UI verification')),
      async () => assert.equal(digest(JSON.stringify(await planSuite(root, baseline))), identity.planHash, 'UI test sources changed during verification'),
    ]) {
      try { await check(); }
      catch (error) { errors.push(errorMessage(error)); failures.push(error); }
    }
    if (manifest) {
      const result = { ...identity, shardIndex, shardCount: manifest.shardCount, files, errors };
      await fs.writeFile(path.join(directory, `shard-${shardIndex}.json`), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
      if (failures.length) throw new AggregateError(failures, failures.map(errorMessage).join('\n\n'));
      checkResults({ files: selected }, files);
      assert(shardIndex !== undefined, 'Invalid UI shard index');
      console.log(`Verified shard ${shardIndex + 1}/${manifest.shardCount}: ${files.length} regression files against renderer ${identity.rendererHash}.`);
      return result;
    }
    if (failures.length) throw new AggregateError(failures, failures.map(errorMessage).join('\n\n'));
    checkResults(plan, files);
    const receipt = { ...identity, files };
    await fs.writeFile(path.join(root, 'out', receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    console.log(`Verified ${files.length} regression files against renderer ${identity.rendererHash}.`);
    return receipt;
  } finally { execFileSync('gio', ['trash', retained.scratch]); }
}

/** Only a complete set of passing shards can produce the existing installer receipt. */
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function mergeGate({ root = appRoot, baseline = baselineCommit, manifest, shards }: { root?: string; baseline?: string; manifest?: Manifest; shards?: Shard[] } = {}) {
  const snapshot = await gateSnapshot(root, baseline);
  assert(manifest, 'A UI shard plan is required');
  checkManifest(snapshot, manifest);
  const errors: unknown[] = [], seen = new Set<number>(), byFile = new Map<string, FileResult>();
  const check = (fn: () => void) => { try { fn(); } catch (error) { errors.push(error); } };
  assert(Array.isArray(shards), 'UI shard results must be an array');
  for (const shard of shards) {
    check(() => assert(shard && typeof shard === 'object', 'Invalid UI shard result'));
    if (!shard || typeof shard !== 'object') continue;
    const label = `UI shard ${shard.shardIndex}`;
    check(() => assert(!seen.has(shard.shardIndex), `Duplicate UI shard ${shard.shardIndex}`));
    seen.add(shard.shardIndex);
    check(() => assert.equal(shard.schemaVersion, 1, `${label} has an unsupported schema`));
    for (const [key, description] of [['commit', 'source commit'], ['baseline', 'baseline'], ['planHash', 'plan hash'], ['rendererHash', 'renderer hash'], ['shardCount', 'shard count']] as const) {
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
  if (errors.length) throw new AggregateError(errors, errors.map(errorMessage).join('\n\n'));
  const { plan, ...identity } = snapshot;
  const files = plan.files.map(file => { const result = byFile.get(JSON.stringify([file.source, file.name])); assert(result, `Missing UI regression ${file.source}/${file.name}`); return result; });
  checkResults(plan, files);
  checkManifest(await gateSnapshot(root, baseline), manifest);
  const receipt = { ...identity, files };
  await fs.writeFile(path.join(root, 'out', receiptName), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  console.log(`Merged ${manifest.shardCount} shards: verified ${files.length} regression files against renderer ${identity.rendererHash}.`);
  return receipt;
}

async function main([mode, ...args]: string[]) {
  if (mode === '--prepare') return prepareGate({ evidence: args[0], shardCount: Number(args[1]) });
  if (mode === '--shard' || mode === '--merge') {
    assert(args[0], 'A UI shard plan is required');
    const manifest: Manifest = JSON.parse(await fs.readFile(args[0], 'utf8'));
    if (mode === '--shard') return runGate({ manifest, shardIndex: Number(args[1]), evidence: args[2] });
    const results = args[1];
    assert(results, 'A UI shard results directory is required');
    const shards: Shard[] = await Promise.all((await fs.readdir(results)).filter(name => /^shard-\d+\.json$/.test(name))
      .sort().map(async name => JSON.parse(await fs.readFile(path.join(results, name), 'utf8'))));
    return mergeGate({ manifest, shards });
  }
  assert(mode && !mode.startsWith('--') && args.length === 0, 'Use <evidence> or --prepare <evidence> <count>, --shard <plan.json> <index> <evidence>, --merge <plan.json> <results>');
  return runGate({ evidence: mode });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
