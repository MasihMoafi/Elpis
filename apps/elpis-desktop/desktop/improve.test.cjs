const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { tryImprovement, regionRect } = require('./improve.cjs');
test('region capture bounds reject invalid or invisible areas', () => {
  assert.deepEqual(regionRect({ x: 95, y: 5, width: 20, height: 20 }, { width: 100, height: 80 }), { x: 95, y: 5, width: 5, height: 20 });
  for (const rect of [null, { x: NaN }, { x: 101, y: 0, width: 2, height: 2 }]) assert.throws(() => regionRect(rect, { width: 100, height: 80 }));
});
test('Try it launches the candidate build with distinct runtime and desktop profiles, without inherited live sockets', async t => {
  const cache = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(cache, { recursive: true });
  const root = await fs.mkdtemp(path.join(cache, 'preview-test-')); let captured;
  t.after(() => promisify(execFile)('gio', ['trash', root]));
  await fs.mkdir(path.join(root, 'apps/elpis-desktop/out'), { recursive: true }); await fs.writeFile(path.join(root, 'apps/elpis-desktop/out/index.html'), 'built');
  const home = path.join(root, 'home'); await fs.mkdir(home); await fs.writeFile(path.join(home, 'auth.json'), 'fixture credentials');
  await tryImprovement({ cwd: root }, { env: { ELPIS_HOME: home, ELPIS_APP_BRIDGE_SOCKET: '/real.sock', ELPIS_BRIDGE_SOCKET: '/other.sock' }, launch: (bin, args, options) => {
    captured = { bin, args, options }; const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child;
  } });
  const env = captured.options.env;
  t.after(() => promisify(execFile)('gio', ['trash', path.dirname(env.ELPIS_HOME)]));
  assert.equal(captured.args[0], path.join(root, 'apps/elpis-desktop')); assert.notEqual(env.ELPIS_HOME, home);
  assert.ok(env.ELPIS_DESKTOP_PROFILE.startsWith(path.dirname(env.ELPIS_HOME))); assert.equal(env.ELPIS_APP_BRIDGE_SOCKET, undefined); assert.equal(env.ELPIS_BRIDGE_SOCKET, undefined);
  assert.equal(await fs.readFile(path.join(env.ELPIS_HOME, 'auth.json'), 'utf8'), 'fixture credentials');
});
