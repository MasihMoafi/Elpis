const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function runGuard(temperature, mode = 'check', selectedRepo, testFilter, extraEnv = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-build-guard-test-'));
  try {
    for (const directory of ['scripts', 'codex-rs', 'bin', 'thermal/hwmon/hwmon0']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    const script = path.join(root, 'scripts/build-elpis-local');
    fs.copyFileSync(path.join(__dirname, 'build-elpis-local'), script);
    fs.mkdirSync(path.join(root, 'candidate/codex-rs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'candidate/codex-rs/Cargo.toml'), '[workspace]\n');
    fs.mkdirSync(path.join(root, 'codex-rs/config-schema/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'codex-rs/config-schema/Cargo.toml'),
      '[package]\nname = "codex-config-schema"\n[[bin]]\nname = "codex-write-config-schema"\npath = "src/main.rs"\n');
    fs.writeFileSync(path.join(root, 'codex-rs/config-schema/src/main.rs'),
      '#[derive(clap::Parser)]\nstruct Args { #[arg(short, long)] out: Option<std::path::PathBuf> }\n');
    fs.writeFileSync(path.join(root, 'bin/rustc'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'bin/cargo'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$ELPIS_GUARD_TEST_MARKER"\nprintf "%s" "$RUSTFLAGS" > "$ELPIS_GUARD_TEST_MARKER.flags"\npwd > "$ELPIS_GUARD_TEST_MARKER.cwd"\nmkdir -p "$CARGO_TARGET_DIR/local-release"\nprintf x > "$CARGO_TARGET_DIR/local-release/codex-app-server"\nsleep 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'thermal/hwmon/hwmon0/temp1_input'), `${temperature}\n`);
    const marker = path.join(root, 'compiler-started');
    const filterSideEffect = path.join(root, 'filter-side-effect');
    const literalFilter = testFilter?.replace('{SENTINEL}', filterSideEffect);
    const result = spawnSync('timeout', ['4s', 'bash', script, mode], {
      encoding: 'utf8', timeout: 7000,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
        ELPIS_BUILD_JOBS: '1', ELPIS_RUSTC_THREADS: '1', ELPIS_MAX_TEMP_C: '75',
        ELPIS_THERMAL_ROOT: `${root}/thermal`, ELPIS_TEMP_POLL_SECONDS: '0.1',
        ELPIS_GUARD_TEST_MARKER: marker,
        ELPIS_TEST_FILTER: literalFilter || '',
        CARGO_TARGET_DIR: `${root}/shared-target`,
        ELPIS_BUILD_REPO_ROOT: selectedRepo === undefined ? '' : path.join(root, selectedRepo),
        CODEX_APP_SERVER_SCHEMA_ROOT: '',
        CODEX_APP_SERVER_SCHEMA_EXPERIMENTAL: '',
        ELPIS_CONFIG_SCHEMA_OUT: '',
        ...extraEnv },
    });
    return { ...result, compilerStarted: fs.existsSync(marker), args: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').map((arg) => arg.replaceAll(root, 'FIXTURE')) : [], flags:fs.existsSync(`${marker}.flags`)?fs.readFileSync(`${marker}.flags`,'utf8').replaceAll(root,'FIXTURE'):'', cwd:fs.existsSync(`${marker}.cwd`)?fs.readFileSync(`${marker}.cwd`,'utf8').trim().replaceAll(root,'FIXTURE'):'', filterSideEffect:fs.existsSync(filterSideEffect), configSchemaManifest:fs.readFileSync(path.join(root,'codex-rs/config-schema/Cargo.toml'),'utf8'), configSchemaMain:fs.readFileSync(path.join(root,'codex-rs/config-schema/src/main.rs'),'utf8') };
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

test('focused core tests reuse core-test-build flags and default to Smart Prune', () => {
  const build = runGuard(50000, 'core-test-build');
  const result = runGuard(50000, 'core-tests');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(result.args,
    ['test', '--profile', 'local-release', '--locked', '--offline', '-p', 'codex-core', '--lib', 'smart_prune', '--', '--test-threads=1']);
  assert.equal(result.flags, build.flags);
});

test('focused core test filter is one literal Cargo argument', () => {
  const filter = 'override filter;$(touch {SENTINEL})';
  const result = runGuard(50000, 'core-tests', undefined, filter);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.args[8], filter.replace('{SENTINEL}', 'FIXTURE/filter-side-effect'));
  assert.equal(result.filterSideEffect, false, 'test filter was evaluated by a shell');
});

test('focused core tests retain worktree and thermal startup gates', () => {
  const badWorktree = runGuard(50000, 'core-tests', 'missing');
  assert.equal(badWorktree.status, 2, badWorktree.stdout + badWorktree.stderr);
  assert.equal(badWorktree.compilerStarted, false);
  const hot = runGuard(75000, 'core-tests');
  assert.equal(hot.status, 75, hot.stdout + hot.stderr);
  assert.equal(hot.compilerStarted, false);
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

test('schema modes use the protocol library tests and stable optimized flags', () => {
  const optimized = runGuard(50000, 'optimized');
  const build = runGuard(50000, 'schema-build');
  const write = runGuard(50000, 'schema-write', undefined, undefined, {
    CODEX_APP_SERVER_SCHEMA_ROOT: '/tmp/schema-output',
    CODEX_APP_SERVER_SCHEMA_EXPERIMENTAL: '0',
  });
  const tests = runGuard(50000, 'schema-tests');
  for (const result of [build, write, tests]) {
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(result.flags, optimized.flags);
  }
  assert.deepEqual(build.args,
    ['test', '--profile', 'local-release', '--locked', '--offline', '-p', 'codex-app-server-protocol', '--lib', '--no-run']);
  assert.deepEqual(write.args,
    ['test', '--profile', 'local-release', '--locked', '--offline', '-p', 'codex-app-server-protocol', '--lib',
      'schema_fixtures_tests::write_schema_fixtures_from_env', '--', '--exact', '--ignored', '--test-threads=1']);
  assert.deepEqual(tests.args,
    ['test', '--profile', 'local-release', '--locked', '--offline', '-p', 'codex-app-server-protocol', '--lib',
      'schema_fixtures_tests::', '--', '--test-threads=1']);
});

test('schema writer rejects missing or invalid output controls before Cargo', () => {
  for (const extraEnv of [
    {},
    { CODEX_APP_SERVER_SCHEMA_ROOT: '/tmp/schema-output' },
    { CODEX_APP_SERVER_SCHEMA_ROOT: '/tmp/schema-output', CODEX_APP_SERVER_SCHEMA_EXPERIMENTAL: 'yes' },
  ]) {
    const result = runGuard(50000, 'schema-write', undefined, undefined, extraEnv);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.compilerStarted, false);
  }
});

test('config schema writer runs the native core binary with an explicit destination', () => {
  const optimized = runGuard(50000, 'optimized');
  const result = runGuard(50000, 'config-schema-write', undefined, undefined, {
    ELPIS_CONFIG_SCHEMA_OUT: '/tmp/config.schema.json',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.configSchemaManifest, /name = "codex-config-schema"/);
  assert.match(result.configSchemaManifest, /name = "codex-write-config-schema"/);
  assert.match(result.configSchemaMain, /arg\(short, long\).*out:/s);
  assert.deepEqual(result.args,
    ['run', '--profile', 'local-release', '--locked', '--offline', '-p', 'codex-config-schema',
      '--bin', 'codex-write-config-schema', '--', '--out', '/tmp/config.schema.json']);
  assert.equal(result.flags, optimized.flags);
});

test('config schema writer rejects missing or relative destinations before Cargo', () => {
  for (const output of ['', 'relative/config.schema.json']) {
    const result = runGuard(50000, 'config-schema-write', undefined, undefined, {
      ELPIS_CONFIG_SCHEMA_OUT: output,
    });
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(result.compilerStarted, false);
  }
});
