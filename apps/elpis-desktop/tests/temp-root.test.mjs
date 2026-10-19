import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestTempDir, removeTestTempDir } from './temp-root.cjs';

test('cleanup removes its own mkdtemp roots in both allowed locations', t => {
  for (const base of [os.tmpdir(), path.join(os.homedir(), '.cache/elpis-tests')]) {
    fs.mkdirSync(base, { recursive: true });
    const root = createTestTempDir(path.join(base, 'cleanup-owned-'));
    t.after(() => removeTestTempDir(root));
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'marker'), 'owned data');
    removeTestTempDir(root);
    assert.equal(fs.existsSync(root), false);
    removeTestTempDir(root); // Repeated teardown is harmless.
  }
});

test('cleanup refuses HOME, /, the allowed bases, unowned and nested paths', t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'cleanup-refuse-'));
  t.after(() => removeTestTempDir(root));
  const plain = path.join(root, 'not-mkdtemp');
  fs.mkdirSync(plain);
  fs.writeFileSync(path.join(plain, 'marker'), 'keep');
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-foreign-'));
  t.after(() => fs.rmdirSync(foreign));
  for (const target of [os.homedir(), '/', os.tmpdir(), path.join(os.homedir(), '.cache/elpis-tests'), path.join(os.tmpdir(), 'not-mkdtemp'), foreign, plain, `${root}-other`]) {
    assert.throws(() => removeTestTempDir(target), /Refusing/);
  }
  assert.throws(() => createTestTempDir(path.join(root, 'nested-')), /Refusing/);
  assert.equal(fs.statSync(foreign).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(plain, 'marker'), 'utf8'), 'keep');
});

test('a removed root does not authorize a replacement at the same path', () => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'cleanup-reused-'));
  removeTestTempDir(root);
  fs.mkdirSync(root);
  try { assert.throws(() => removeTestTempDir(root), /Refusing/); }
  finally { fs.rmdirSync(root); }
});

test('a symlink cannot redirect cleanup outside its owned root', t => {
  const root = createTestTempDir(path.join(os.tmpdir(), 'cleanup-link-'));
  t.after(() => removeTestTempDir(root));
  const link = path.join(root, 'escape');
  fs.symlinkSync(os.homedir(), link);
  assert.throws(() => removeTestTempDir(link), /Refusing/);

  const replaced = createTestTempDir(path.join(os.tmpdir(), 'cleanup-replaced-'));
  fs.rmdirSync(replaced);
  fs.symlinkSync(os.homedir(), replaced);
  try { assert.throws(() => removeTestTempDir(replaced), /Refusing/); }
  finally { fs.unlinkSync(replaced); removeTestTempDir(replaced); }
});
