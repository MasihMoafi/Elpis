import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baselineCommit, passingCounts, planSuite, prepareBaseline, receiptName, rendererHash, runGate, verifyRendererReceipt } from '../scripts/renderer-artifact-gate.mjs';

const tap = ({ tests = 1, pass = 1, fail = 0, cancelled = 0, skipped = 0, todo = 0 } = {}) =>
  Object.entries({ tests, pass, fail, cancelled, skipped, todo }).map(([key, value]) => `# ${key} ${value}`).join('\n');

test('real UI results require positive passes and no skipped, pending or cancelled cases', () => {
  assert.equal(passingCounts(tap()).pass, 1);
  for (const counts of [{ tests: 0, pass: 0 }, { pass: 0, skipped: 1 }, { pass: 0, todo: 1 }, { pass: 0, cancelled: 1 }, { pass: 0, fail: 1 }]) {
    assert.throws(() => passingCounts(tap(counts)), `reject ${JSON.stringify(counts)}`);
  }
  assert.throws(() => passingCounts(''), /TAP/);
});

async function fixture(t, code) {
  const base = path.join(os.homedir(), '.cache/elpis-tests');
  await fs.mkdir(base, { recursive: true });
  const repo = await fs.mkdtemp(path.join(base, 'renderer-gate-test-'));
  t.after(() => execFileSync('gio', ['trash', repo]));
  const root = path.join(repo, 'apps/elpis-desktop');
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const inventory = { fast: [], bridge: [], desktop: [], ui: ['tests/kept.test.cjs'], 'opt-in': [] };
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(repo, '.gitignore'), 'apps/elpis-desktop/out/\n');
  await fs.writeFile(path.join(root, 'test-inventory.json'), JSON.stringify(inventory));
  await fs.writeFile(path.join(root, 'implementation.cjs'), 'module.exports = "old";');
  await fs.writeFile(path.join(root, 'tests/helper.cjs'), 'module.exports = "retained helper";');
  await fs.writeFile(path.join(root, 'tests/kept.test.cjs'), code ?? `const {test}=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs');
test('retained behavior executes the candidate implementation and renderer',()=>{
  assert.equal(require('../implementation.cjs'),'candidate');
  assert.equal(require('./helper.cjs'),'retained helper');
  assert.equal(fs.readFileSync('out/index.html','utf8'),'candidate renderer');
});`);
  git(['init', '-q']); git(['config', 'user.name', 'UI gate fixture']); git(['config', 'user.email', 'ui-gate@example.invalid']);
  git(['add', '.']); git(['-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'retained checkpoint']);
  const baseline = git(['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(root, 'implementation.cjs'), 'module.exports = "candidate";');
  const commit = async () => {
    git(['add', '.']); git(['-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-qm', 'candidate']);
    const head = git(['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(root, 'out/.commit'), head + '\n');
    return head;
  };
  await fs.writeFile(path.join(root, 'out/index.html'), 'candidate renderer');
  await commit();
  return { root, repo, baseline, inventory, commitSource: commit, out: path.join(root, 'out'), evidence: path.join(repo, 'evidence') };
}

test('the real gate retains dropped tests, uses candidate imports, and binds the resulting renderer receipt', async t => {
  const f = await fixture(t);
  // A candidate may remove an old test and update its own inventory at the same time.
  await fs.rename(path.join(f.root, 'tests/kept.test.cjs'), path.join(f.repo, 'dropped-test.cjs'));
  await fs.writeFile(path.join(f.root, 'tests/new.test.cjs'), "const{test}=require('node:test');test('new regression',()=>{});");
  f.inventory.ui = ['tests/new.test.cjs'];
  await fs.writeFile(path.join(f.root, 'test-inventory.json'), JSON.stringify(f.inventory));
  await f.commitSource();
  const receipt = await runGate(f);
  assert.deepEqual(receipt.files.map(file => [file.source, file.name]), [['baseline', 'tests/kept.test.cjs'], ['candidate', 'tests/new.test.cjs']]);
  assert.equal((await verifyRendererReceipt(f)).rendererHash, await rendererHash(f.out));
  const receiptFile = path.join(f.out, receiptName);
  const original = await fs.readFile(receiptFile, 'utf8');
  for (const patch of [{ commit: 'stale' }, { baseline: 'stale' }, { files: receipt.files.slice(1) },
    { files: receipt.files.map(file => ({ ...file, pass: 0, skipped: file.tests })) }]) {
    await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, ...patch }));
    await assert.rejects(verifyRendererReceipt(f));
  }
  await fs.writeFile(receiptFile, original);
  await fs.writeFile(path.join(f.out, 'index.html'), 'stale renderer');
  await assert.rejects(verifyRendererReceipt(f), /Renderer bytes changed/);
});

test('missing receipts and build-only artifacts cannot be activated', async t => {
  const f = await fixture(t);
  await assert.rejects(verifyRendererReceipt(f), { code: 'ENOENT' });
  await fs.writeFile(path.join(f.out, receiptName), JSON.stringify({ commit: 'old' }));
  await assert.rejects(verifyRendererReceipt(f), /Unsupported UI receipt/);
});

test('unchanged test/helper bytes deduplicate; changed helpers require the candidate tests too', async t => {
  const f = await fixture(t);
  assert.equal((await planSuite(f.root, f.baseline)).files.length, 1);
  await fs.writeFile(path.join(f.root, 'tests/helper.cjs'), 'module.exports = "different helper";');
  assert.deepEqual((await planSuite(f.root, f.baseline)).files.map(file => file.source), ['baseline', 'candidate']);
  const retained = await prepareBaseline(f.root, f.baseline);
  try {
    assert.match(await fs.readFile(path.join(retained.root, 'tests/helper.cjs'), 'utf8'), /retained helper/);
    assert.equal(await fs.realpath(path.join(retained.root, 'implementation.cjs')), path.join(f.root, 'implementation.cjs'));
    assert.equal(await fs.realpath(path.join(retained.root, 'out')), f.out);
  } finally { execFileSync('gio', ['trash', retained.scratch]); }
});

for (const [name, body] of [
  ['assertion failure', "const{test}=require('node:test');const assert=require('node:assert/strict');test('broken',()=>assert.equal(1,2));"],
  ['skipped case', "const{test}=require('node:test');test('skipped',{skip:true},()=>{});"],
  ['zero selected cases', 'module.exports = {};'],
  ['mutated renderer', "const{test}=require('node:test');const fs=require('node:fs');test('mutate',()=>fs.writeFileSync('out/index.html','changed'));"],
]) test(`no receipt is minted for ${name}`, async t => {
  const f = await fixture(t, body);
  await assert.rejects(runGate(f), name === 'mutated renderer' ? /changed the renderer/ : /failed|positive passes|no named test cases/);
  await assert.rejects(fs.access(path.join(f.out, receiptName)), { code: 'ENOENT' });
});

for (const mode of ['missing', 'stale', 'mutated', 'valid']) test(`the actual --actions installer checks ${mode} artifacts before selecting`, async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'scripts'));
  await fs.mkdir(path.join(f.root, 'desktop'));
  for (const file of ['install-desktop.mjs', 'renderer-artifact-gate.mjs', 'test-gate.mjs', 'gate-guards.mjs']) {
    await fs.copyFile(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(f.root, 'scripts', file));
  }
  // The isolated repository has its own immutable checkpoint; production keeps the deployed checkpoint.
  const helper = path.join(f.root, 'scripts/renderer-artifact-gate.mjs');
  await fs.writeFile(helper, (await fs.readFile(helper, 'utf8')).replace(baselineCommit, f.baseline));
  await fs.writeFile(path.join(f.root, 'desktop/package.mjs'), `import fs from "node:fs";import path from "node:path";
fs.writeFileSync(process.env.PACKAGING_MARKER,"called");
const destination=process.argv[process.argv.indexOf('--destination')+1];
fs.cpSync(process.env.SOURCE_OUT,path.join(destination,'app/out'),{recursive:true});
if(process.env.MOCK_RECEIPT==='mutated')fs.writeFileSync(path.join(destination,'app/out/index.html'),'changed while packaging');`);
  const commit = await f.commitSource();
  if (mode === 'valid' || mode === 'mutated') await runGate(f);
  const home = path.join(f.repo, 'private-home'), bin = path.join(f.repo, 'bin');
  const previous = path.join(home, '.local/lib/elpis-desktop/versions/previous/launch');
  await fs.mkdir(path.dirname(previous), { recursive: true });
  await fs.writeFile(previous, 'previous');
  await fs.mkdir(path.join(home, '.local/bin'), { recursive: true });
  const selected = path.join(home, '.local/bin/elpis-app');
  await fs.symlink(previous, selected);
  await fs.mkdir(bin);
  const temporary = path.join(home, 'tmp');
  await fs.mkdir(temporary);
  await fs.writeFile(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
if(process.argv[3]==='list')console.log(JSON.stringify([{databaseId:1}]));
else {const folder=process.argv[process.argv.indexOf('--dir')+1];
fs.writeFileSync(path.join(folder,'.commit'),process.env.MOCK_COMMIT);
if(process.env.MOCK_RECEIPT==='valid'||process.env.MOCK_RECEIPT==='mutated')fs.cpSync(process.env.SOURCE_OUT,folder,{recursive:true});
if(process.env.MOCK_RECEIPT==='stale')fs.writeFileSync(path.join(folder,${JSON.stringify(receiptName)}),JSON.stringify({schemaVersion:1,commit:'stale'}));}
`, { mode: 0o755 });
  const marker = path.join(f.repo, 'packaging-called');
  const env = { ...process.env, HOME: home, TMPDIR: temporary, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    MOCK_COMMIT: commit, MOCK_RECEIPT: mode, PACKAGING_MARKER: marker, SOURCE_OUT: f.out };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['scripts/install-desktop.mjs', 'candidate', '--actions'], { cwd: f.root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, mode === 'valid' ? 0 : 1, result.stderr);
  if (mode === 'missing' || mode === 'stale') {
    assert.match(result.stderr, mode === 'missing' ? /ENOENT.*elpis-ui-receipt/ : /UI receipt belongs to another commit/);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.dirname(path.dirname(previous))), ['previous']);
  } else assert.equal(await fs.readFile(marker, 'utf8'), 'called');
  if (mode === 'mutated') assert.match(result.stderr, /Renderer bytes changed/);
  assert.equal(await fs.readlink(selected), mode === 'valid' ? path.join(path.dirname(path.dirname(previous)), `candidate-${commit.slice(0, 9)}/launch`) : previous);
});
