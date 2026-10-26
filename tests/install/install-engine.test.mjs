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
  const frontend = path.join(home, '.local/lib/elpis-next/versions/frontend');
  const bin = path.join(home, '.local/bin');
  for (const dir of [bin, frontend, `${old}/codex-resources`, `${old}/tools/elpis-claude`, `${source}/codex-rs/target/release`, `${source}/codex-rs/prompts`, `${source}/tools/elpis-claude`]) mkdirSync(dir, { recursive: true });
  const executable = (file, text = '#!/bin/sh\nexit 0\n') => { writeFileSync(file, text); chmodSync(file, 0o755); };
  executable(`${source}/codex-rs/target/release/codex`, '#!/bin/sh\nprintf "elpis 0.4.1\\n"\n');
  executable(`${old}/elpis-next`, '#!/bin/sh\necho old-engine\n');
  executable(`${frontend}/elpis-next`, '#!/bin/sh\necho old-frontend\n');
  executable(`${old}/codex-code-mode-host`);
  executable(`${old}/codex-resources/bwrap`);
  const direct = 'direct() {\n  exec "$REAL" "$@"\n}';
  executable(`${old}/elpis-wrapper`, `#!/bin/sh\nREAL="${old}/elpis-next"\nFRONTEND="${frontend}/elpis-next"\n${direct}\n[ "${'${1:-}'}" = --version ] && direct "$@"\nexec "$FRONTEND" "$@"\n`);
  writeFileSync(`${bin}/elpis`, readFileSync(`${old}/elpis-wrapper`));
  chmodSync(`${bin}/elpis`, 0o755);
  symlinkSync(`${old}/elpis-next`, `${bin}/elpis-next`);
  // Bridge dependencies can contain external directory links. They must never enter the CLI package.
  symlinkSync(source, `${old}/tools/elpis-claude/node_modules`);
  writeFileSync(`${source}/tools/elpis-claude/runtime.mjs`, 'export const fixture = true;\n');
  writeFileSync(`${source}/tools/elpis-claude/elpis-wrapper`, `#!/bin/sh\n${direct}\n`);
  writeFileSync(`${source}/codex-rs/prompts/fixture.md`, 'prompt\n');
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' });
  git('init', '-q');
  git('add', 'tools/elpis-claude/runtime.mjs', 'tools/elpis-claude/elpis-wrapper', 'codex-rs/prompts/fixture.md');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'fixture');
  const head = git('rev-parse', 'HEAD').toString().trim();
  writeFileSync(`${frontend}/verification.json`, JSON.stringify({ head: head.slice(0, 9), run: 1 }));
  const run = (...args) => spawnSync('bash', [installer, ...args], { env: { ...process.env, HOME: home, ELPIS_SOURCE: source, CARGO_TARGET_DIR: `${source}/codex-rs/target` }, encoding: 'utf8' });
  const bundle = () => path.dirname(realpathSync(`${bin}/elpis-next`)).replace(/\/package\/bin$/, '');
  return { home, source, old, frontend, bin, run, bundle, git, head };
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
  assert.equal(execFileSync(`${f.bin}/elpis`, [], { encoding: 'utf8' }).trim(), 'old-frontend');
  assert.equal(f.run('first').status, 1, 'duplicate bundle must be refused');
  const second = f.run('second');
  assert.equal(second.status, 0, second.stderr);
  execFileSync('bash', [`${f.bundle()}/rollback.sh`], { env: { ...process.env, HOME: f.home } });
  assert.equal(f.bundle(), bundle);
  execFileSync('bash', [`${bundle}/rollback.sh`], { env: { ...process.env, HOME: f.home } });
  assert.deepEqual(readFileSync(`${f.bin}/elpis`), before);
  assert.equal(readlinkSync(`${f.bin}/elpis-next`), `${f.old}/elpis-next`);
});

test('the live launcher is kept, with only its engine and bridge paths moved to the new bundle', (t) => {
  const f = fixture(t);
  // 21 Oct: the bundle's own wrapper copy was older than the live launcher and lacked its pinned TUI frontend.
  const live = readFileSync(`${f.bin}/elpis`, 'utf8').replace('direct() {', `BRIDGE_DIR="${f.old}/tools/elpis-claude"\nif [ "${'${1:-}'}" = --launcher-marker ]; then printf '%s\\n' "$BRIDGE_DIR"; exit 0; fi\ndirect() {`);
  writeFileSync(`${f.bin}/elpis`, live);
  const result = f.run('live');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(execFileSync(`${f.bin}/elpis`, ['--launcher-marker'], { encoding: 'utf8' }).trim(), `${f.bundle()}/tools/elpis-claude`);
  assert.equal(execFileSync(`${f.bin}/elpis`, [], { encoding: 'utf8' }).trim(), 'old-frontend');
});

test('engine-only installs preserve a frontend pin even when it shares the previous engine bundle', (t) => {
  const f = fixture(t);
  writeFileSync(`${f.bin}/elpis`, readFileSync(`${f.bin}/elpis`, 'utf8').replace(/^FRONTEND=.*$/m, `FRONTEND="${f.old}/elpis-next"`));
  const result = f.run('engine-only');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(execFileSync(`${f.bin}/elpis`, [], { encoding: 'utf8' }).trim(), 'old-engine');
  assert.equal(execFileSync(`${f.bin}/elpis`, ['--version'], { encoding: 'utf8' }).trim(), 'elpis 0.4.1');
});

test('explicit frontend installs move forward from legacy and new receipts, with exact rollback', (t) => {
  const f = fixture(t, true);
  const before = readFileSync(`${f.bin}/elpis`);
  const advance = () => f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-qm', 'advance');
  advance();
  const first = f.run('--with-frontend', 'frontend-first');
  assert.equal(first.status, 0, first.stderr);
  const firstBundle = f.bundle();
  const firstWrapper = readFileSync(`${f.bin}/elpis`);
  assert.equal(execFileSync(`${f.bin}/elpis`, [], { encoding: 'utf8' }).trim(), 'elpis 0.4.1');
  assert.equal(JSON.parse(readFileSync(`${firstBundle}/source.json`, 'utf8')).source_head, f.git('rev-parse', 'HEAD').toString().trim());
  advance();
  const second = f.run('--with-frontend', 'frontend-second');
  assert.equal(second.status, 0, second.stderr);
  execFileSync('bash', [`${f.bundle()}/rollback.sh`], { env: { ...process.env, HOME: f.home } });
  assert.deepEqual(readFileSync(`${f.bin}/elpis`), firstWrapper);
  assert.equal(f.bundle(), firstBundle);
  assert.equal(execFileSync(`${f.bin}/elpis`, [], { encoding: 'utf8' }).trim(), 'elpis 0.4.1');
  execFileSync('bash', [`${firstBundle}/rollback.sh`], { env: { ...process.env, HOME: f.home } });
  assert.deepEqual(readFileSync(`${f.bin}/elpis`), before);
  assert.equal(readlinkSync(`${f.bin}/elpis-next`), `${f.old}/elpis-next`);
  assert.equal(execFileSync(`${f.bin}/elpis`, [], { encoding: 'utf8' }).trim(), 'old-frontend');
});

test('frontend promotion refuses missing, malformed, unknown, and divergent source provenance before activation', async (t) => {
  for (const reason of ['missing', 'malformed', 'unknown', 'divergent', 'missing-head', 'shell-expression']) {
    await t.test(reason, (t) => {
      const f = fixture(t);
      const receipt = `${f.frontend}/verification.json`;
      if (reason === 'missing') execFileSync('gio', ['trash', receipt]);
      if (reason === 'malformed') writeFileSync(receipt, '{');
      if (reason === 'unknown') writeFileSync(receipt, JSON.stringify({ head: 'f'.repeat(40) }));
      if (reason === 'missing-head') writeFileSync(receipt, '{}');
      if (reason === 'divergent') {
        f.git('checkout', '--orphan', 'divergent');
        f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', 'divergent');
        writeFileSync(receipt, JSON.stringify({ head: f.git('rev-parse', 'HEAD').toString().trim() }));
        f.git('checkout', '--detach', f.head);
      }
      const marker = `${f.home}/must-not-exist`;
      if (reason === 'shell-expression') writeFileSync(`${f.bin}/elpis`, readFileSync(`${f.bin}/elpis`, 'utf8').replace(/^FRONTEND=.*$/m, `FRONTEND=$(touch "${marker}")`));
      const before = readFileSync(`${f.bin}/elpis`);
      const result = f.run('--with-frontend', 'refused');
      assert.notEqual(result.status, 0, result.stdout);
      assert.deepEqual(readFileSync(`${f.bin}/elpis`), before);
      assert.equal(readlinkSync(`${f.bin}/elpis-next`), `${f.old}/elpis-next`);
      assert.ok(!existsSync(marker));
      assert.deepEqual(readdirSync(path.dirname(f.old)).sort(), ['frontend', 'old']);
    });
  }
});

test('a code-mode host built with the engine is preferred over the previous bundle\'s', (t) => {
  const f = fixture(t);
  writeFileSync(`${f.source}/codex-rs/target/release/codex-code-mode-host`, '#!/bin/sh\necho built-with-engine\n');
  chmodSync(`${f.source}/codex-rs/target/release/codex-code-mode-host`, 0o755);
  const result = f.run('host');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(`${f.bundle()}/package/bin/codex-code-mode-host`, 'utf8'), '#!/bin/sh\necho built-with-engine\n');
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
