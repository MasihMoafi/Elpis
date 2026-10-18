import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const installer = process.env.INSTALL_ENGINE_SCRIPT ?? path.resolve('scripts/install-engine.sh');
function fixture(t, spaces = false) {
  const scratch = path.join(homedir(), '.cache/elpis-tests');
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, 'engine-install-'));
  t.after(() => execFileSync('gio', ['trash', root]));
  const home = path.join(root, spaces ? 'home with spaces' : 'home');
  const source = path.join(root, spaces ? 'source with spaces' : 'source');
  const old = path.join(home, '.local/lib/elpis-next/versions/old');
  const bin = path.join(home, '.local/bin');
  for (const dir of [bin, `${old}/codex-resources`, `${old}/tools/elpis-claude`, `${source}/codex-rs/target/release`, `${source}/codex-rs/prompts`, `${source}/tools/elpis-claude`]) mkdirSync(dir, { recursive: true });
  const executable = (file, text = '#!/bin/sh\nexit 0\n') => { writeFileSync(file, text); chmodSync(file, 0o755); };
  executable(`${source}/codex-rs/target/release/codex`, '#!/bin/sh\nprintf "elpis 0.4.1\\n"\n');
  executable(`${old}/elpis-next`);
  executable(`${old}/codex-code-mode-host`);
  executable(`${old}/codex-resources/bwrap`);
  executable(`${old}/elpis-wrapper`, `#!/bin/sh\nexec "${old}/elpis-next" "$@"\n`);
  writeFileSync(`${bin}/elpis`, readFileSync(`${old}/elpis-wrapper`));
  chmodSync(`${bin}/elpis`, 0o755);
  symlinkSync(`${old}/elpis-next`, `${bin}/elpis-next`);
  // Bridge dependencies can contain external directory links. They must never enter the CLI package.
  symlinkSync(source, `${old}/tools/elpis-claude/node_modules`);
  writeFileSync(`${source}/tools/elpis-claude/runtime.mjs`, 'export const fixture = true;\n');
  writeFileSync(`${source}/codex-rs/prompts/fixture.md`, 'prompt\n');
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', 'tools/elpis-claude/runtime.mjs', 'codex-rs/prompts/fixture.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture');
  const run = (name) => spawnSync('bash', [installer, name], { env: { ...process.env, HOME: home, ELPIS_SOURCE: source }, encoding: 'utf8' });
  const bundle = () => path.dirname(realpathSync(`${bin}/elpis-next`)).replace(/\/package\/bin$/, '');
  return { home, source, old, bin, run, bundle };
}

test('installs a self-contained local package and preserves rollback across two installs', (t) => {
  const f = fixture(t);
  const before = readFileSync(`${f.bin}/elpis`);
  const first = f.run('first');
  assert.equal(first.status, 0, first.stderr);
  const bundle = f.bundle();
  const pkg = `${bundle}/package`;
  const manifest = JSON.parse(readFileSync(`${pkg}/codex-package.json`, 'utf8'));
  assert.equal(manifest.entrypoint, 'bin/codex');
  assert.equal(manifest.layoutVersion, 1);
  assert.match(manifest.version, /^0\.4\.1\+elpis\.[a-f0-9]{8,64}$/);
  assert.equal(manifest.target, 'x86_64-unknown-linux-gnu');
  for (const file of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg', 'codex-resources/bwrap']) assert.ok(lstatSync(`${pkg}/${file}`).mode & 0o111, file);
  assert.equal(realpathSync(`${f.bin}/elpis-next`), `${pkg}/bin/codex`);
  const inspect = (dir) => { for (const name of readdirSync(dir)) { const file = `${dir}/${name}`; assert.ok(!lstatSync(file).isSymbolicLink(), file); if (lstatSync(file).isDirectory()) inspect(file); } };
  inspect(pkg);
  assert.ok(existsSync(`${bundle}/tools/elpis-claude/node_modules`));
  assert.equal(execFileSync(`${f.bin}/elpis`, ['--version'], { encoding: 'utf8' }).trim(), 'elpis 0.4.1');
  assert.equal(f.run('first').status, 1, 'duplicate bundle must be refused');
  const second = f.run('second');
  assert.equal(second.status, 0, second.stderr);
  execFileSync('bash', [`${f.bundle()}/rollback.sh`], { env: { ...process.env, HOME: f.home } });
  assert.equal(f.bundle(), bundle);
  execFileSync('bash', [`${bundle}/rollback.sh`], { env: { ...process.env, HOME: f.home } });
  assert.deepEqual(readFileSync(`${f.bin}/elpis`), before);
  assert.equal(readlinkSync(`${f.bin}/elpis-next`), `${f.old}/elpis-next`);
});

test('incomplete prerequisites fail before activation', (t) => {
  const f = fixture(t);
  execFileSync('gio', ['trash', `${f.old}/codex-resources/bwrap`]);
  const before = readFileSync(`${f.bin}/elpis`);
  const result = f.run('incomplete');
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(`${f.bin}/elpis`), before);
  assert.equal(readlinkSync(`${f.bin}/elpis-next`), `${f.old}/elpis-next`);
});

test('invalid bundle names cannot escape the versions directory', (t) => {
  const f = fixture(t);
  const before = readFileSync(`${f.bin}/elpis`);
  assert.notEqual(f.run('../outside').status, 0);
  assert.deepEqual(readFileSync(`${f.bin}/elpis`), before);
  assert.equal(readlinkSync(`${f.bin}/elpis-next`), `${f.old}/elpis-next`);
});

test('source and install paths can contain spaces', (t) => {
  const f = fixture(t, true);
  const result = f.run('spaces');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(execFileSync(`${f.bin}/elpis`, ['--version'], { encoding: 'utf8' }).trim(), 'elpis 0.4.1');
});
