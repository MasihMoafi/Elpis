const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function runGuard(temperature, mode = 'check') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-build-guard-test-'));
  try {
    for (const directory of ['scripts', 'codex-rs', 'bin', 'thermal/hwmon/hwmon0']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    const script = path.join(root, 'scripts/build-elpis-local');
    fs.copyFileSync(path.join(__dirname, 'build-elpis-local'), script);
    fs.writeFileSync(path.join(root, 'bin/rustc'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'bin/cargo'),
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$ELPIS_GUARD_TEST_MARKER"\nprintf "%s" "$RUSTFLAGS" > "$ELPIS_GUARD_TEST_MARKER.flags"\nsleep 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'thermal/hwmon/hwmon0/temp1_input'), `${temperature}\n`);
    const marker = path.join(root, 'compiler-started');
    const result = spawnSync('timeout', ['4s', 'bash', script, mode], {
      encoding: 'utf8', timeout: 7000,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
        ELPIS_BUILD_JOBS: '1', ELPIS_RUSTC_THREADS: '1', ELPIS_MAX_TEMP_C: '75',
        ELPIS_THERMAL_ROOT: `${root}/thermal`, ELPIS_TEMP_POLL_SECONDS: '0.1',
        ELPIS_GUARD_TEST_MARKER: marker },
    });
    return { ...result, compilerStarted: fs.existsSync(marker), args: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n') : [], flags:fs.existsSync(`${marker}.flags`)?fs.readFileSync(`${marker}.flags`,'utf8').replaceAll(root,'FIXTURE'):'' };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('cool builds complete', () => {
  const result = runGuard(50000);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.compilerStarted, true);
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

test('TUI and config tests use separate Cargo feature graphs', () => {
  for (const [mode, crate] of [['test-build', 'codex-tui'], ['config-test-build', 'codex-config']]) {
    const result = runGuard(50000, mode);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(result.args.flatMap((arg, i) => arg === '-p' ? [result.args[i + 1]] : []), [crate]);
    assert(result.args.includes('--no-run'));
    assert(result.args.includes('--offline'));
  }
});

test('schema export reuses optimized runtime compiler flags and packages',()=>{
  const optimized=runGuard(50000,'optimized'),schema=runGuard(50000,'schema-build');
  assert.equal(optimized.status,0,optimized.stdout+optimized.stderr);
  assert.equal(schema.status,0,schema.stdout+schema.stderr);
  assert.equal(schema.flags,optimized.flags);
  assert.deepEqual(schema.args.slice(0,optimized.args.length),optimized.args);
  assert(schema.args.includes('write_schema_fixtures'));
});
