import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codeIdentity } from '../shared-runtime.mts';

test('bridge identity changes when TypeScript runtime code changes', t => {
  const engine = process.env.ELPIS_ENGINE_BIN;
  process.env.ELPIS_ENGINE_BIN = process.execPath;
  t.after(() => { if (engine === undefined) delete process.env.ELPIS_ENGINE_BIN; else process.env.ELPIS_ENGINE_BIN = engine; });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bridge = path.join(dir, 'bridge.mjs');
  const module = path.join(dir, 'helper.mts');
  fs.writeFileSync(bridge, 'export {};');
  fs.writeFileSync(module, 'export const version = 1;');
  const first = codeIdentity(bridge).hash;
  assert.equal(codeIdentity(bridge).hash, first);
  fs.writeFileSync(module, 'export const version = 2;');
  assert.notEqual(codeIdentity(bridge).hash, first);
});
