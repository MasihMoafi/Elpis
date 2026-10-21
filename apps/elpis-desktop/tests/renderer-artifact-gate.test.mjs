import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baselineCommit, passingCounts, planSuite, prepareBaseline, receiptName, rendererHash, runGate, verifyPackagedSources, verifyRendererReceipt } from '../scripts/renderer-artifact-gate.mjs';
import * as gate from '../scripts/renderer-artifact-gate.mjs';

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
  const identity = { name: 'elpis-desktop', productName: 'Fixture Elpis', desktopName: 'fixture.desktop', version: '0.1.0', main: 'desktop/main.cjs', private: true };
  const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const inventory = { fast: [], bridge: [], desktop: ['desktop/state.test.cjs'], ui: ['tests/kept.test.cjs'], 'opt-in': [] };
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.mkdir(path.join(root, 'desktop'));
  await fs.writeFile(path.join(root, 'desktop/main.cjs'), 'module.exports = "original app";');
  await fs.writeFile(path.join(root, 'desktop/state.cjs'), "module.exports={read(values){if(Object.keys(values).some(key=>!['theme','projectChats'].includes(key)))throw Error('saved workspace');return values;}};");
  await fs.writeFile(path.join(root, 'desktop/state.test.cjs'), "const{test}=require('node:test');const assert=require('node:assert/strict');const{read}=require('./state.cjs');test('saved project membership survives',()=>assert.deepEqual(read({theme:'dark',projectChats:['chat']}),{theme:'dark',projectChats:['chat']}));");
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(repo, '.gitignore'), 'apps/elpis-desktop/out/\n');
  await fs.writeFile(path.join(root, 'test-inventory.json'), JSON.stringify(inventory));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ ...identity, dependencies: { react: 'fixture' } }));
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
  return { root, repo, baseline, identity, inventory, commitSource: commit, out: path.join(root, 'out'), evidence: path.join(repo, 'evidence') };
}

const hashPlan = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex');
async function shardManifest(f, shardCount = 3) {
  const plan = await planSuite(f.root, f.baseline);
  return { schemaVersion: 1, commit: (await fs.readFile(path.join(f.out, '.commit'), 'utf8')).trim(),
    baseline: f.baseline, rendererHash: await rendererHash(f.out), planHash: hashPlan(plan), shardCount, plan };
}
const passedFile = file => ({ ...file, tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0, cases: ['retained behavior'] });
const shardResults = manifest => Array.from({ length: manifest.shardCount }, (_, shardIndex) => {
  const { plan, ...identity } = manifest;
  return { ...identity, shardIndex, errors: [], files: plan.files.filter((_, i) => i % manifest.shardCount === shardIndex).map(passedFile) };
});

test('stable slices are disjoint and cover every planned baseline and candidate file', () => {
  const plan = { files: Array.from({ length: 305 }, (_, i) => ({ source: i % 2 ? 'baseline' : 'candidate', name: `tests/${i}.test.cjs`, blob: String(i) })) };
  for (const count of [1, 2, 6, 310]) {
    const slices = Array.from({ length: count }, (_, i) => gate.slicePlan(plan, i, count));
    assert.equal(new Set(slices.flat()).size, plan.files.length);
    assert.deepEqual(slices.flat().sort((a, b) => Number(a.blob) - Number(b.blob)), plan.files);
    slices.forEach((slice, i) => assert.deepEqual(slice, plan.files.filter((_, at) => at % count === i)));
    assert.deepEqual(gate.slicePlan({ files: [] }, 0, count), []);
  }
  for (const [index, count] of [[0, 0], [-1, 6], [6, 6], [0.5, 6], [0, 1.5], [NaN, 6]]) {
    assert.throws(() => gate.slicePlan(plan, index, count), /shard/i);
  }
});

test('prepare writes the renderer and plan identity once without a receipt', async t => {
  const f = await fixture(t);
  const manifest = await gate.prepareGate({ ...f, shardCount: 6 });
  assert.deepEqual(manifest, await shardManifest(f, 6));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.evidence, 'plan.json'), 'utf8')), manifest);
  await assert.rejects(gate.prepareGate({ ...f, shardCount: 6 }), /empty/);
  await assert.rejects(fs.access(path.join(f.out, receiptName)), { code: 'ENOENT' });
});

test('shards execute only their slice, including an empty slice; the merged receipt passes the installer verifier', async t => {
  const f = await fixture(t), manifest = await shardManifest(f);
  const shards = [];
  for (let shardIndex = 0; shardIndex < manifest.shardCount; shardIndex++) {
    const evidence = path.join(f.evidence, String(shardIndex));
    const result = await runGate({ ...f, evidence, manifest, shardIndex });
    assert.deepEqual(result.files.map(({ source, name, blob }) => ({ source, name, blob })), manifest.plan.files.filter((_, i) => i % manifest.shardCount === shardIndex));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(evidence, `shard-${shardIndex}.json`), 'utf8')), result);
    await assert.rejects(fs.access(path.join(f.out, receiptName)), { code: 'ENOENT' });
    shards.push(result);
  }
  const receipt = await gate.mergeGate({ ...f, manifest, shards: shards.toReversed() });
  assert.deepEqual(receipt.files.map(({ source, name, blob }) => ({ source, name, blob })), manifest.plan.files);
  assert.deepEqual(await verifyRendererReceipt(f), receipt);
  assert.deepEqual(Object.keys(receipt).sort(), ['baseline', 'commit', 'files', 'planHash', 'rendererHash', 'schemaVersion']);
});

test('the prepare, shard and merge CLI commands preserve the downloaded renderer and per-file evidence', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'scripts'));
  for (const name of ['renderer-artifact-gate.mjs', 'test-gate.mjs', 'gate-guards.mjs']) {
    const source = await fs.readFile(new URL(`../scripts/${name}`, import.meta.url), 'utf8');
    await fs.writeFile(path.join(f.root, 'scripts', name), source.replace(baselineCommit, f.baseline));
  }
  await f.commitSource();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const cli = args => spawnSync(process.execPath, ['scripts/renderer-artifact-gate.mjs', ...args], { cwd: f.root, env, encoding: 'utf8', timeout: 10000 });
  const prepared = path.join(f.repo, 'prepared'), results = path.join(f.repo, 'results');
  await fs.mkdir(results);
  let run = cli(['--prepare', prepared, '3']);
  assert.equal(run.status, 0, run.stderr);
  const manifest = JSON.parse(await fs.readFile(path.join(prepared, 'plan.json'), 'utf8'));
  for (let index = 0; index < manifest.shardCount; index++) {
    const evidence = path.join(f.evidence, String(index));
    run = cli(['--shard', path.join(prepared, 'plan.json'), String(index), evidence]);
    assert.equal(run.status, 0, run.stderr);
    await fs.cp(evidence, results, { recursive: true });
  }
  run = cli(['--merge', path.join(prepared, 'plan.json'), results]);
  assert.equal(run.status, 0, run.stderr);
  const receipt = await verifyRendererReceipt(f);
  assert.equal(receipt.rendererHash, manifest.rendererHash);
  for (const file of receipt.files) await fs.access(path.join(results, `${file.source}-${file.name.replaceAll('/', '-')}.tap`));
});

for (const [name, mutate, error] of [
  ['a missing shard', shards => shards.pop(), /Missing UI shard/],
  ['a duplicate shard', shards => shards.push(structuredClone(shards[0])), /Duplicate UI shard/],
  ['a duplicate file', shards => shards[1].files.push(structuredClone(shards[0].files[0])), /Duplicate UI regression/],
  ['a missing file', shards => shards[0].files.pop(), /omits regression files/],
  ['a different renderer hash', shards => { shards[0].rendererHash = 'other'; }, /different renderer hash/],
  ['a different plan hash', shards => { shards[0].planHash = 'other'; }, /different plan hash/],
  ['a different commit', shards => { shards[0].commit = 'other'; }, /different source commit/],
  ['a different shard count', shards => { shards[0].shardCount++; }, /different shard count/],
  ['a failing file', shards => { shards[0].files[0].fail = 1; shards[0].files[0].pass = 0; }, /positive passes|UI tests failed/],
  ['a skipped file', shards => { shards[0].files[0].skipped = 1; }, /UI tests failed/],
  ['a shard integrity error', shards => { shards[0].errors.push('Tracked source changed during UI verification'); }, /Tracked source changed/],
]) test(`merge rejects ${name} without writing a receipt`, async t => {
  const f = await fixture(t), manifest = await shardManifest(f), shards = shardResults(manifest);
  mutate(shards);
  await assert.rejects(gate.mergeGate({ ...f, manifest, shards }), error);
  await assert.rejects(fs.access(path.join(f.out, receiptName)), { code: 'ENOENT' });
});

test('a failed shard saves every file TAP and result and the merge lists all failures', async t => {
  const f = await fixture(t, "const{test}=require('node:test');test('first regression',()=>{throw Error('first regression failed')});");
  await fs.writeFile(path.join(f.root, 'tests/later.test.cjs'), "const{test}=require('node:test');test('later regression',()=>{throw Error('later regression failed')});");
  await fs.writeFile(path.join(f.root, 'tests/last.test.cjs'), "const{test}=require('node:test');test('last regression still runs',()=>{});");
  f.inventory.ui.push('tests/later.test.cjs', 'tests/last.test.cjs');
  await fs.writeFile(path.join(f.root, 'test-inventory.json'), JSON.stringify(f.inventory));
  await f.commitSource();
  const manifest = await shardManifest(f, 1);
  const allFailures = error => /first regression failed/.test(error.message) && /later regression failed/.test(error.message);
  await assert.rejects(runGate({ ...f, manifest, shardIndex: 0 }), allFailures);
  const shard = JSON.parse(await fs.readFile(path.join(f.evidence, 'shard-0.json'), 'utf8'));
  assert.equal(shard.files.length, manifest.plan.files.length);
  assert.equal(shard.files.filter(file => file.error).length, 2);
  for (const file of manifest.plan.files) await fs.access(path.join(f.evidence, `${file.source}-${file.name.replaceAll('/', '-')}.tap`));
  assert.match(await fs.readFile(path.join(f.evidence, 'candidate-tests-last.test.cjs.tap'), 'utf8'), /ok 1 - last regression still runs/);
  await assert.rejects(gate.mergeGate({ ...f, manifest, shards: [shard] }), allFailures);
  await assert.rejects(fs.access(path.join(f.out, receiptName)), { code: 'ENOENT' });
});

for (const [name, body, error] of [
  ['renderer bytes', "require('node:fs').writeFileSync(require('node:path').join(root,'out/index.html'),'changed')", /changed the renderer/],
  ['tracked source', "require('node:fs').writeFileSync(require('node:path').join(root,'implementation.cjs'),'changed')", /Tracked source changed/],
  ['source HEAD', "require('node:child_process').execFileSync('git',['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','changed'],{cwd:root})", /Source commit changed/],
  ['test support bytes', "require('node:fs').writeFileSync(require('node:path').join(root,'tests/untracked-helper.cjs'),'changed')", /UI test sources changed/],
]) test(`shards reject changed ${name} during the run and preserve their diagnostics`, async t => {
  const f = await fixture(t, `const{test}=require('node:test');test('mutation',()=>{const root=require('node:path').dirname(require.resolve('../implementation.cjs'));${body}});`);
  const manifest = await shardManifest(f, 1);
  await assert.rejects(runGate({ ...f, manifest, shardIndex: 0 }), error);
  const shard = JSON.parse(await fs.readFile(path.join(f.evidence, 'shard-0.json'), 'utf8'));
  assert(shard.errors.some(message => error.test(message)));
  await assert.rejects(fs.access(path.join(f.out, receiptName)), { code: 'ENOENT' });
});

test('shards and the merger reject renderer or plan changes since preparation and dirty source', async t => {
  const f = await fixture(t), manifest = await shardManifest(f), shards = shardResults(manifest);
  for (const [key, value, error] of [['rendererHash', 'other', /renderer/], ['planHash', 'other', /plan/]]) {
    const changed = { ...manifest, [key]: value };
    await assert.rejects(runGate({ ...f, evidence: path.join(f.evidence, key), manifest: changed, shardIndex: 0 }), error);
    await assert.rejects(gate.mergeGate({ ...f, manifest: changed, shards }), error);
  }
  await fs.writeFile(path.join(f.root, 'implementation.cjs'), 'changed');
  await assert.rejects(runGate({ ...f, evidence: path.join(f.evidence, 'dirty'), manifest, shardIndex: 0 }), /source changes|Tracked source changed/);
  await assert.rejects(gate.mergeGate({ ...f, manifest, shards }), /source changes|Tracked source changed/);
});

test('the real gate retains dropped tests, uses candidate imports, and binds the resulting renderer receipt', async t => {
  const f = await fixture(t);
  // A candidate may remove an old test and update its own inventory at the same time.
  await fs.rename(path.join(f.root, 'tests/kept.test.cjs'), path.join(f.repo, 'dropped-test.cjs'));
  await fs.writeFile(path.join(f.root, 'tests/new.test.cjs'), "const{test}=require('node:test');test('new regression',()=>{});");
  f.inventory.ui = ['tests/new.test.cjs'];
  await fs.writeFile(path.join(f.root, 'test-inventory.json'), JSON.stringify(f.inventory));
  await f.commitSource();
  const receipt = await runGate(f);
  assert.deepEqual(receipt.files.map(file => [file.source, file.name]), [['baseline', 'desktop/state.test.cjs'], ['baseline', 'tests/kept.test.cjs'], ['candidate', 'tests/new.test.cjs']]);
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
  assert.equal((await planSuite(f.root, f.baseline)).files.length, 2);
  await fs.writeFile(path.join(f.root, 'tests/helper.cjs'), 'module.exports = "different helper";');
  assert.deepEqual((await planSuite(f.root, f.baseline)).files.map(file => file.source), ['baseline', 'baseline', 'candidate', 'candidate']);
  const retained = await prepareBaseline(f.root, f.baseline);
  try {
    assert.match(await fs.readFile(path.join(retained.root, 'tests/helper.cjs'), 'utf8'), /retained helper/);
    assert.equal(await fs.realpath(path.join(retained.root, 'implementation.cjs')), path.join(f.root, 'implementation.cjs'));
    assert.equal(await fs.realpath(path.join(retained.root, 'out')), f.out);
  } finally { execFileSync('gio', ['trash', retained.scratch]); }
});

test('a candidate cannot drop the saved-workspace test and reinstate a reader that rejects project memberships', async t => {
  const f = await fixture(t);
  await fs.rename(path.join(f.root, 'desktop/state.test.cjs'), path.join(f.repo, 'dropped-state.test.cjs'));
  f.inventory.desktop = [];
  await fs.writeFile(path.join(f.root, 'test-inventory.json'), JSON.stringify(f.inventory));
  await fs.writeFile(path.join(f.root, 'desktop/state.cjs'), "module.exports={read(values){if('projectChats' in values)throw Error('saved workspace');return values;}};");
  await f.commitSource();
  assert.equal((await planSuite(f.root, f.baseline)).files[0].name, 'desktop/state.test.cjs');
  await assert.rejects(runGate(f), /saved workspace/);
  await assert.rejects(fs.access(path.join(f.out, receiptName)), { code: 'ENOENT' });
});

test('a failed regression still records later checks without accepting the renderer', async t => {
  const f = await fixture(t, "const{test}=require('node:test');test('first regression',()=>{throw Error('first regression failed')});");
  await fs.writeFile(path.join(f.root, 'tests/later.test.cjs'), "const{test}=require('node:test');test('later regression still runs',()=>{});");
  f.inventory.ui.push('tests/later.test.cjs');
  await fs.writeFile(path.join(f.root, 'test-inventory.json'), JSON.stringify(f.inventory));
  await f.commitSource();
  await assert.rejects(runGate(f), /first regression failed/);
  const later = await fs.readFile(path.join(f.evidence, 'candidate-tests-later.test.cjs.tap'), 'utf8');
  assert.match(later, /ok 1 - later regression still runs/);
  await assert.rejects(fs.access(path.join(f.out, receiptName)), { code: 'ENOENT' });
});

test('private screenshot peers retain discoverable Unix socket names', async t => {
  const f = await fixture(t, `const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const net=require('node:net');const{randomUUID}=require('node:crypto');
test('screenshot peer discovery and connection',async()=>{const directory=path.join(os.tmpdir(),'elpis-shots-'+process.getuid()+'-0123456789abcdef');await fs.mkdir(directory,{recursive:true});const socket=path.join(directory,randomUUID()+'.sock');const server=net.createServer(client=>client.end('shared'));
try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve)});assert.ok((await fs.readdir(directory)).includes(path.basename(socket)),'Unix socket filename was truncated');assert.equal(await new Promise((resolve,reject)=>{let data='';const client=net.createConnection(socket);client.on('data',chunk=>data+=chunk);client.on('end',()=>resolve(data));client.on('error',reject)}),'shared');}finally{await new Promise(resolve=>server.close(resolve));}});`);
  await runGate(f);
});

test('drawing and screenshot writes stay inside the private test home', async t => {
  const f = await fixture(t, `const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
test('private drawing paths',()=>{for(const[key,dir]of[['EXCALIDRAW_LOCAL_DIR','love-spot'],['EXCALIDRAW_SCREENSHOTS_DIR','Screenshots']]){
assert.equal(process.env[key],path.join(process.env.HOME,dir));fs.mkdirSync(process.env[key],{recursive:true});fs.writeFileSync(path.join(process.env[key],'private'),'fixture');}});`);
  const external = path.join(f.repo, 'external');
  await fs.mkdir(external);
  await runGate({ ...f, env: { ...process.env, EXCALIDRAW_LOCAL_DIR: external, EXCALIDRAW_SCREENSHOTS_DIR: external } });
  assert.deepEqual(await fs.readdir(external), []);
});

test('a package cannot omit the saved-workspace reader after its source tests pass', async t => {
  const f = await fixture(t), destination = path.join(f.repo, 'package');
  await fs.mkdir(path.join(destination, 'app/desktop'), { recursive: true });
  await fs.copyFile(path.join(f.root, 'desktop/main.cjs'), path.join(destination, 'app/desktop/main.cjs'));
  await fs.writeFile(path.join(destination, 'app/package.json'), JSON.stringify({ ...f.identity, type: 'module', dependencies: { ws: 'fixture' } }));
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: [{ path: 'app/desktop/main.cjs' }] }));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim();
  await assert.rejects(verifyPackagedSources({ root: f.root, destination, commit }), /omits.*desktop\/state.cjs/);
});

test('generated identity and tracked source bytes follow the initial commit', async t => {
  const f = await fixture(t), destination = path.join(f.repo, 'package');
  await fs.mkdir(path.join(destination, 'app/desktop'), { recursive: true });
  const files = ['desktop/main.cjs', 'desktop/state.cjs', 'implementation.cjs'];
  for (const file of files) await fs.copyFile(path.join(f.root, file), path.join(destination, 'app', file));
  const identity = { ...f.identity, type: 'module', dependencies: { ws: 'generated bundle dependency' } };
  const identityFile = path.join(destination, 'app/package.json');
  await fs.writeFile(identityFile, JSON.stringify(identity));
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ schemaVersion: 1, files: files.map(file => ({ path: `app/${file}`, generated: true })) }));
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: f.root, encoding: 'utf8' }).trim();
  await verifyPackagedSources({ root: f.root, destination, commit });
  for (const [key, value] of Object.entries({ name: 'wrong-app', productName: 'Wrong App', desktopName: 'wrong.desktop', version: '9.9.9', main: 'wrong.cjs', private: false, type: 'commonjs' })) {
    await fs.writeFile(identityFile, JSON.stringify({ ...identity, [key]: value }));
    await assert.rejects(verifyPackagedSources({ root: f.root, destination, commit }), new RegExp(`Packaged desktop identity differs.*${key}`));
  }
  await fs.writeFile(identityFile, JSON.stringify(identity));
  await fs.writeFile(path.join(destination, 'app/implementation.cjs'), 'copied transient mutation');
  await assert.rejects(verifyPackagedSources({ root: f.root, destination, commit }), /Packaged production bytes differ.*implementation/);
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

for (const mode of ['missing', 'stale', 'mutated', 'download-source', 'download-head', 'package-source', 'transient-source', 'transient-identity', 'valid']) test(`the actual --actions installer checks ${mode} artifacts before selecting`, async t => {
  const f = await fixture(t);
  // The real installer records a durable Elpis checkout through this source module.
  await fs.mkdir(path.join(f.root, 'bridge'));
  await fs.copyFile(new URL('../bridge/improve-source.mjs', import.meta.url), path.join(f.root, 'bridge/improve-source.mjs'));
  const identity = JSON.parse(await fs.readFile(path.join(f.root, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(f.root, 'package.json'), JSON.stringify({ ...identity, name: 'elpis-desktop' }));
  await fs.mkdir(path.join(f.root, 'scripts'));
  for (const file of ['install-desktop.mjs', 'renderer-artifact-gate.mjs', 'test-gate.mjs', 'gate-guards.mjs']) {
    await fs.copyFile(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(f.root, 'scripts', file));
  }
  await fs.mkdir(path.join(f.root, 'bridge'));
  await fs.copyFile(fileURLToPath(new URL('../bridge/improve-source.mjs', import.meta.url)), path.join(f.root, 'bridge/improve-source.mjs'));
  // The installer reads the approved looks next to its folder (A109).
  await fs.copyFile(fileURLToPath(new URL('../approved-looks.json', import.meta.url)), path.join(f.root, 'approved-looks.json'));
  // The isolated repository has its own immutable checkpoint; production keeps the deployed checkpoint.
  const helper = path.join(f.root, 'scripts/renderer-artifact-gate.mjs');
  await fs.writeFile(helper, (await fs.readFile(helper, 'utf8')).replace(baselineCommit, f.baseline));
  await fs.writeFile(path.join(f.root, 'desktop/package.mjs'), `import fs from "node:fs";import path from "node:path";
fs.writeFileSync(process.env.PACKAGING_MARKER,"called");
const destination=process.argv[process.argv.indexOf('--destination')+1];
const main=path.join('desktop','main.cjs'), original=fs.readFileSync(main);
if(['package-source','transient-source'].includes(process.env.MOCK_RECEIPT))fs.writeFileSync(main,'mutated while packaging');
fs.cpSync(process.env.SOURCE_OUT,path.join(destination,'app/out'),{recursive:true});
fs.mkdirSync(path.join(destination,'app/desktop'),{recursive:true});fs.copyFileSync(main,path.join(destination,'app/desktop/main.cjs'));
fs.copyFileSync('desktop/state.cjs',path.join(destination,'app/desktop/state.cjs'));
const identityOriginal=fs.readFileSync('package.json');
if(process.env.MOCK_RECEIPT==='transient-identity'){const identity=JSON.parse(identityOriginal);identity.name='wrong-user-data';identity.version='9.9.9';fs.writeFileSync('package.json',JSON.stringify(identity));}
const identity=JSON.parse(fs.readFileSync('package.json','utf8'));
fs.writeFileSync(path.join(destination,'app/package.json'),JSON.stringify({name:identity.name,productName:identity.productName||'Elpis',desktopName:identity.desktopName,version:identity.version,main:'desktop/main.cjs',private:true,type:'module',dependencies:{ws:'fixture'}}));
if(process.env.MOCK_RECEIPT==='transient-identity')fs.writeFileSync('package.json',identityOriginal);
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({schemaVersion:1,files:[{path:'app/desktop/main.cjs'},{path:'app/desktop/state.cjs'},{path:'app/package.json',generated:true}]}));
if(process.env.MOCK_RECEIPT==='transient-source')fs.writeFileSync(main,original);
if(process.env.MOCK_RECEIPT==='mutated')fs.writeFileSync(path.join(destination,'app/out/index.html'),'changed while packaging');`);
  const commit = await f.commitSource();
  if (!['missing', 'stale'].includes(mode)) await runGate(f);
  const home = path.join(f.repo, 'private-home'), bin = path.join(f.repo, 'bin');
  // The selected installation carries an earlier commit of this repository, so the install moves forward.
  const previous = path.join(home, `.local/lib/elpis-desktop/versions/previous-${f.baseline.slice(0, 9)}/launch`);
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
if(!['missing','stale'].includes(process.env.MOCK_RECEIPT))fs.cpSync(process.env.SOURCE_OUT,folder,{recursive:true});
if(process.env.MOCK_RECEIPT==='download-source')fs.writeFileSync('desktop/main.cjs','mutated during download');
if(process.env.MOCK_RECEIPT==='download-head')require('node:child_process').execFileSync('git',['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','during download']);
if(process.env.MOCK_RECEIPT==='stale')fs.writeFileSync(path.join(folder,${JSON.stringify(receiptName)}),JSON.stringify({schemaVersion:1,commit:'stale'}));}
`, { mode: 0o755 });
  const marker = path.join(f.repo, 'packaging-called');
  const env = { ...process.env, HOME: home, TMPDIR: temporary, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    MOCK_COMMIT: commit, MOCK_RECEIPT: mode, PACKAGING_MARKER: marker, SOURCE_OUT: f.out };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['scripts/install-desktop.mjs', 'candidate', '--actions'], { cwd: f.root, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, mode === 'valid' ? 0 : 1, result.stderr);
  if (mode === 'missing' || mode === 'stale' || mode === 'download-source' || mode === 'download-head') {
    assert.match(result.stderr, mode === 'missing' ? /ENOENT.*elpis-ui-receipt/ : mode === 'stale' ? /UI receipt belongs to another commit/ : mode === 'download-head' ? /Source HEAD changed/ : /Tracked source changed/);
    await assert.rejects(fs.access(marker), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.dirname(path.dirname(previous))), [path.basename(path.dirname(previous))]);
  } else assert.equal(await fs.readFile(marker, 'utf8'), 'called');
  if (mode === 'mutated') assert.match(result.stderr, /Renderer bytes changed/);
  if (mode === 'package-source' || mode === 'transient-source') assert.match(result.stderr, /Tracked source changed|Packaged production bytes differ/);
  if (mode === 'transient-identity') assert.match(result.stderr, /Packaged desktop identity differs/);
  assert.equal(await fs.readlink(selected), mode === 'valid' ? path.join(path.dirname(path.dirname(previous)), `candidate-${commit.slice(0, 9)}/launch`) : previous);
});
