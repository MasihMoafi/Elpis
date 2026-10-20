import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { baselineCommit, passingCounts, planSuite, prepareBaseline, receiptName, rendererHash, runGate, verifyPackagedSources, verifyRendererReceipt } from '../scripts/renderer-artifact-gate.mjs';

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
  const identity = { name: 'fixture-desktop', productName: 'Fixture Elpis', desktopName: 'fixture.desktop', version: '0.1.0', main: 'desktop/main.cjs', private: true };
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
  await fs.mkdir(path.join(f.root, 'scripts'));
  for (const file of ['install-desktop.mjs', 'renderer-artifact-gate.mjs', 'test-gate.mjs', 'gate-guards.mjs']) {
    await fs.copyFile(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), path.join(f.root, 'scripts', file));
  }
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
    assert.deepEqual(await fs.readdir(path.dirname(path.dirname(previous))), ['previous']);
  } else assert.equal(await fs.readFile(marker, 'utf8'), 'called');
  if (mode === 'mutated') assert.match(result.stderr, /Renderer bytes changed/);
  if (mode === 'package-source' || mode === 'transient-source') assert.match(result.stderr, /Tracked source changed|Packaged production bytes differ/);
  if (mode === 'transient-identity') assert.match(result.stderr, /Packaged desktop identity differs/);
  assert.equal(await fs.readlink(selected), mode === 'valid' ? path.join(path.dirname(path.dirname(previous)), `candidate-${commit.slice(0, 9)}/launch`) : previous);
});
