const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function runGuard(temperature, mode = 'check', selectedRepo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-build-guard-test-'));
  try {
    for (const directory of ['scripts', 'codex-rs', 'bin', 'thermal/hwmon/hwmon0']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    const script = path.join(root, 'scripts/build-elpis-local');
    fs.copyFileSync(path.join(__dirname, 'build-elpis-local'), script);
    fs.mkdirSync(path.join(root, 'candidate/codex-rs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'candidate/codex-rs/Cargo.toml'), '[workspace]\n');
    fs.writeFileSync(path.join(root, 'bin/rustc'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'bin/cargo'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$ELPIS_GUARD_TEST_MARKER"\nprintf "%s" "$RUSTFLAGS" > "$ELPIS_GUARD_TEST_MARKER.flags"\npwd > "$ELPIS_GUARD_TEST_MARKER.cwd"\nmkdir -p "$CARGO_TARGET_DIR/local-release"\nprintf x > "$CARGO_TARGET_DIR/local-release/codex-app-server"\nsleep 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'thermal/hwmon/hwmon0/temp1_input'), `${temperature}\n`);
    const marker = path.join(root, 'compiler-started');
    const result = spawnSync('timeout', ['4s', 'bash', script, mode], {
      encoding: 'utf8', timeout: 7000,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
        ELPIS_BUILD_JOBS: '1', ELPIS_RUSTC_THREADS: '1', ELPIS_MAX_TEMP_C: '75',
        ELPIS_THERMAL_ROOT: `${root}/thermal`, ELPIS_TEMP_POLL_SECONDS: '0.1',
        ELPIS_GUARD_TEST_MARKER: marker,
        CARGO_TARGET_DIR: `${root}/shared-target`,
        ELPIS_BUILD_REPO_ROOT: selectedRepo === undefined ? '' : path.join(root, selectedRepo) },
    });
    return { ...result, compilerStarted: fs.existsSync(marker), args: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [], flags:fs.existsSync(`${marker}.flags`)?fs.readFileSync(`${marker}.flags`,'utf8').replaceAll(root,'FIXTURE'):'', cwd:fs.existsSync(`${marker}.cwd`)?fs.readFileSync(`${marker}.cwd`,'utf8').trim().replaceAll(root,'FIXTURE'):'' };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('cool builds complete', () => {
  const result = runGuard(50000);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.compilerStarted, true);
  assert.equal(result.cwd, 'FIXTURE/codex-rs');
});

test('core check uses the selected worktree and includes tests without building host binaries', () => {
  const result = runGuard(50000, 'core-check', 'candidate');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.cwd, 'FIXTURE/candidate/codex-rs');
  assert.deepEqual(result.args, ['check', '--locked', '--offline', '-p', 'codex-core', '--all-targets']);
});

test('invalid worktree selection refuses compiler startup', () => {
  const result = runGuard(50000, 'check', 'missing');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.equal(result.compilerStarted, false);
});

test('model catalog verification also builds protocol wire-format tests', () => {
  const result = runGuard(50000, 'models-test-build');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.args.flatMap((arg, i) => arg === '-p' ? [result.args[i + 1]] : []),
    ['codex-protocol', 'codex-models-manager', 'codex-model-provider', 'codex-model-provider-info']);
  assert(result.args.includes('--no-run'));
  assert(result.args.includes('--locked'));
  assert(result.args.includes('--offline'));
});

test('workspace check reports independent failures without stopping at the first crate', () => {
  const result = runGuard(50000, 'workspace-check', 'candidate');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.args,
    ['check', '--workspace', '--all-targets', '--keep-going', '--locked', '--offline']);
});

test('background warmth below the ceiling does not stall builds', () => {
  const result = runGuard(70000);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.compilerStarted, true);
});

test('temperature at the ceiling prevents compiler startup', () => {
  const result = runGuard(75000);
  assert.equal(result.status, 75, result.stdout + result.stderr);
  assert.equal(result.compilerStarted, false);
});

test('TUI, core and config tests use separate Cargo feature graphs', () => {
  for (const [mode, crate] of [['test-build', 'codex-tui'], ['core-test-build', 'codex-core'], ['config-test-build', 'codex-config']]) {
    const result = runGuard(50000, mode);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.args.flatMap((arg, i) => arg === '-p' ? [result.args[i + 1]] : []), [crate]);
    assert(result.args.includes('--no-run'));
    assert(result.args.includes('--offline'));
  }
});

test('app-server library tests use the guarded local-release build', () => {
  const result = runGuard(50000, 'app-server-test-build');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.args,
    ['test', '--profile', 'local-release', '--locked', '--offline', '-p', 'codex-app-server', '--lib', '--no-run']);
});

test('focused Elpis app-server tests run under the guarded compile-only feature graph', () => {
  const build = runGuard(50000, 'app-server-test-build');
  const result = runGuard(50000, 'app-server-tests');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.args,
    ['test', '--profile', 'local-release', '--locked', '--offline', '-p', 'codex-app-server', '--lib', 'elpis_', '--', '--test-threads=1']);
  assert.equal(result.flags, build.flags);
});

test('app-server runtime uses the guarded local-release build and shared target directory', () => {
  const result = runGuard(50000, 'app-server-build');
  const optimized = runGuard(50000, 'optimized');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.args,
    ['build', '--profile', 'local-release', '--locked', '--offline', '-p', 'codex-app-server', '--bin', 'codex-app-server']);
  assert.match(result.stdout, /artifact_bytes=1/);
  assert.equal(result.flags, optimized.flags);
});

test('schema export reuses optimized runtime compiler flags and packages',()=>{
  const optimized=runGuard(50000,'optimized'),schema=runGuard(50000,'schema-build');
  assert.equal(optimized.status,0,optimized.stdout+optimized.stderr);
  assert.equal(schema.status,0,schema.stdout+schema.stderr);
  assert.equal(schema.flags,optimized.flags);
  assert.deepEqual(schema.args.slice(0,optimized.args.length),optimized.args);
  assert(schema.args.includes('write_schema_fixtures'));
});
