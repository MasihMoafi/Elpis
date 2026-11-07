'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Creation is the proof of ownership. A plausible name under /tmp is not enough.
const owned = new Map<string, { parent: string; dev: number; ino: number } | null>();
const bases = [os.tmpdir(), path.join(os.homedir(), '.cache/elpis-tests')].map(base => path.resolve(base));
const refuse = (root: string): never => { throw new Error(`Refusing to remove an unowned or unsafe test temp root: ${root}`); };

function createTestTempDirImpl(prefix: string) {
  if (typeof prefix !== 'string' || !path.isAbsolute(prefix) || prefix !== path.resolve(prefix) || !bases.includes(path.dirname(prefix))) refuse(prefix);
  const parent = fs.realpathSync(path.dirname(prefix));
  const root = fs.mkdtempSync(prefix);
  const stat = fs.lstatSync(root);
  owned.set(root, { parent, dev: stat.dev, ino: stat.ino });
  return root;
}

function removeTestTempDirImpl(root: string) {
  if (!owned.has(root)) refuse(root);
  const original = owned.get(root);
  let stat;
  try { stat = fs.lstatSync(root); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { owned.set(root, null); return; } throw error; }
  if (!original) return refuse(root);
  if (!bases.includes(path.dirname(root)) || fs.realpathSync(path.dirname(root)) !== original.parent) refuse(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== original.dev || stat.ino !== original.ino ||
    fs.realpathSync(root) !== path.join(original.parent, path.basename(root))) refuse(root);
  fs.rmSync(root, { recursive: true, force: true });
  owned.set(root, null);
}

export declare const createTestTempDir: typeof createTestTempDirImpl;
export declare const removeTestTempDir: typeof removeTestTempDirImpl;
exports.createTestTempDir = createTestTempDirImpl;
exports.removeTestTempDir = removeTestTempDirImpl;
