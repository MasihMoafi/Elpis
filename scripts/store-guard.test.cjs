'use strict';
// Exercise the bridge's real store path without starting an engine or provider.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../tools/elpis-claude/acp-bridge.mjs'), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert(from >= 0 && to > from, `bridge store section ${start} must be found`);
  return source.slice(from, to);
}
const storeCode = section('const ELPIS_HOME =', 'const STATE_DIR =');
const jsonCode = section('async function readJson(path)', 'async function claudeLimits()');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-store-guard-'));

function fixture(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  const file = path.join(dir, 'sessions.json');
  const logs = [];
  const previous = process.env.ACP_BRIDGE_STORE;
  process.env.ACP_BRIDGE_STORE = file;
  try {
    const api = new Function('HOME', 'log', `${storeCode}\n${jsonCode}\nreturn { loadStore, updateStore };`)(dir, line => logs.push(line));
    return { ...api, file, dir, logs };
  } finally {
    if (previous === undefined) delete process.env.ACP_BRIDGE_STORE;
    else process.env.ACP_BRIDGE_STORE = previous;
  }
}

test('damaged store is preserved, backed up once, and update reports failure', async () => {
  const f = fixture('damaged');
  const damaged = Buffer.from('{ invalid JSON\n');
  fs.writeFileSync(f.file, damaged);
  const planted = `${f.file}.damaged-earlier`;
  fs.writeFileSync(planted, JSON.stringify({ recoveryMarker: 'saved chats' }));

  assert.equal(await f.updateStore(st => { st.newThread = { model: 'claude/haiku' }; }), false);
  assert.deepEqual(fs.readFileSync(f.file), damaged);
  assert.deepEqual(JSON.parse(fs.readFileSync(planted)), { recoveryMarker: 'saved chats' });
  const copies = fs.readdirSync(f.dir).filter(name => name.startsWith('sessions.json.damaged-') && name !== path.basename(planted));
  assert.equal(copies.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.dir, copies[0])), damaged);
  assert.equal(await f.updateStore(st => { st.newThread = {}; }), false);
  assert.equal(fs.readdirSync(f.dir).filter(name => name.startsWith('sessions.json.damaged-')).length, 2);
  await assert.rejects(f.loadStore(), /cannot load .*sessions\.json/);
  assert.match(f.logs[0], /sessions\.json.*(JSON|SyntaxError|Unexpected)/i);
});

test('missing store is created by an update', async () => {
  const f = fixture('missing');
  assert.equal(await f.updateStore(st => { st.newThread = { model: 'claude/haiku' }; }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), { newThread: { model: 'claude/haiku' } });
});

test('valid store retains other threads during an update', async () => {
  const f = fixture('valid');
  fs.writeFileSync(f.file, JSON.stringify({ otherThread: { turns: [{ id: 'retained' }] } }));
  assert.equal(await f.updateStore(st => { st.newThread = { model: 'agy/gemini' }; }), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file)), {
    otherThread: { turns: [{ id: 'retained' }] }, newThread: { model: 'agy/gemini' },
  });
});
