const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

function runGuard(temperature, mode = 'core-check', selectedRepo, extraEnv = {}, prepare = () => {}) {
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
      '#!/bin/sh\nprintf "%s\\n" "$@" > "$ELPIS_GUARD_TEST_MARKER"\npwd > "$ELPIS_GUARD_TEST_MARKER.cwd"\nprintf "%s" "$INSTA_WORKSPACE_ROOT" > "$ELPIS_GUARD_TEST_MARKER.insta"\nprintf "%s" "$RUST_TEST_THREADS" > "$ELPIS_GUARD_TEST_MARKER.threads"\nif [ -n "$FAKE_PENDING_SNAPSHOT" ]; then mkdir -p tui/src/snapshots; : > tui/src/snapshots/new.snap.new; fi\nsleep 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'thermal/hwmon/hwmon0/temp1_input'), `${temperature}\n`);
    const marker = path.join(root, 'compiler-started');
    prepare(root);
    const result = spawnSync('timeout', ['4s', 'bash', script, mode], {
      encoding: 'utf8', timeout: 7000,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`,
        ELPIS_BUILD_JOBS: '1', ELPIS_RUSTC_THREADS: '1', ELPIS_MAX_TEMP_C: '75',
        ELPIS_THERMAL_ROOT: `${root}/thermal`, ELPIS_TEMP_POLL_SECONDS: '0.1',
        ELPIS_BUILD_MIN_FREE_GB: '0', ELPIS_BUILD_ABORT_FREE_GB: '0',
        ELPIS_TEST_THREADS: '', INSTA_FORCE_PASS: '',
        ELPIS_GUARD_TEST_MARKER: marker,
        ELPIS_BUILD_REPO_ROOT: selectedRepo === undefined ? '' : path.join(root, selectedRepo),
        ...extraEnv },
    });
    return { ...result, compilerStarted: fs.existsSync(marker), args: fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim().split('\n').map((arg) => arg.replaceAll(root, 'FIXTURE')) : [], cwd:fs.existsSync(`${marker}.cwd`)?fs.readFileSync(`${marker}.cwd`,'utf8').trim().replaceAll(root,'FIXTURE'):'', insta:fs.existsSync(`${marker}.insta`)?fs.readFileSync(`${marker}.insta`,'utf8').replaceAll(root,'FIXTURE'):'', threads:fs.existsSync(`${marker}.threads`)?fs.readFileSync(`${marker}.threads`,'utf8'):'' };
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
  const result = runGuard(50000, 'core-check', 'missing');
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

test('snapshots stay in the selected worktree', () => {
  const own = runGuard(50000, 'core-check', undefined, { INSTA_WORKSPACE_ROOT: '/elsewhere/codex-rs' });
  assert.equal(own.status, 0, own.stdout + own.stderr);
  assert.equal(own.insta, 'FIXTURE/codex-rs');
  const selected = runGuard(50000, 'core-check', 'candidate');
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  assert.equal(selected.insta, 'FIXTURE/candidate/codex-rs');
});

test('tests run on two threads unless one is requested', () => {
  const two = runGuard(50000, 'core-check', undefined, { RUST_TEST_THREADS: '8' });
  assert.equal(two.status, 0, two.stdout + two.stderr);
  assert.equal(two.threads, '2');
  const one = runGuard(50000, 'core-check', undefined, { ELPIS_TEST_THREADS: '1' });
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.equal(one.threads, '1');
  const many = runGuard(50000, 'core-check', undefined, { ELPIS_TEST_THREADS: '4' });
  assert.equal(many.status, 2, many.stdout + many.stderr);
  assert.equal(many.compilerStarted, false);
});

test('a force-pass run fails when it writes snapshot files', () => {
  const oldSnapshot = (root) => {
    const file = path.join(root, 'codex-rs/tui/src/snapshots/old.snap.new');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    fs.utimesSync(file, new Date('2000-01-01'), new Date('2000-01-01'));
  };
  const pending = runGuard(50000, 'core-check', undefined,
    { INSTA_FORCE_PASS: '1', FAKE_PENDING_SNAPSHOT: '1' }, oldSnapshot);
  assert.equal(pending.status, 1, pending.stdout + pending.stderr);
  assert.match(pending.stdout, /^snapshot_pending codex-rs\/tui\/src\/snapshots\/new\.snap\.new$/m);
  assert.doesNotMatch(pending.stdout, /old\.snap\.new/);
  assert.match(pending.stdout, /status=snapshots_pending .* snapshots_pending=1$/m);
  const onlyOld = runGuard(50000, 'core-check', undefined, { INSTA_FORCE_PASS: '1' }, oldSnapshot);
  assert.equal(onlyOld.status, 0, onlyOld.stdout + onlyOld.stderr);
  const notRequested = runGuard(50000, 'core-check', undefined, { FAKE_PENDING_SNAPSHOT: '1' });
  assert.equal(notRequested.status, 0, notRequested.stdout + notRequested.stderr);
  assert.doesNotMatch(notRequested.stdout, /snapshot_pending/);
});

// Simulation: a fake cargo ticks into a file while a controlled thermal sensor is moved by the test.
function startSim({ sensors = 1, startTemp = 50000, extraEnv = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-build-guard-sim-'));
  for (const directory of ['scripts', 'codex-rs', 'bin', 'sim', 'thermal/hwmon/hwmon0']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const script = path.join(root, 'scripts/build-elpis-local');
  fs.copyFileSync(path.join(__dirname, 'build-elpis-local'), script);
  fs.writeFileSync(path.join(root, 'codex-rs/Cargo.toml'), '[workspace]\n');
  fs.writeFileSync(path.join(root, 'bin/rustc'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'bin/cargo'), [
    '#!/bin/sh', 'echo $$ > "$SIM/cargo.pid"', 'sleep 60 &', 'echo $! > "$SIM/child.pid"',
    'i=0', 'while [ $i -lt 100 ]; do i=$((i+1)); echo $i >> "$SIM/ticks"; sleep 0.05; done', ''].join('\n'),
    { mode: 0o755 });
  const sensorFile = (n) => path.join(root, `thermal/hwmon/hwmon0/temp${n}_input`);
  const setSensor = (milli, n = 1) => {
    fs.writeFileSync(`${sensorFile(n)}.tmp`, `${milli}\n`);
    fs.renameSync(`${sensorFile(n)}.tmp`, sensorFile(n));
  };
  for (let n = 1; n <= sensors; n += 1) setSensor(startTemp, n);
  const sim = path.join(root, 'sim');
  const child = spawn('bash', [script, 'core-check'], {
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, SIM: sim,
      ELPIS_BUILD_JOBS: '1', ELPIS_RUSTC_THREADS: '1', ELPIS_MAX_TEMP_C: '75',
      ELPIS_THERMAL_ROOT: `${root}/thermal`, ELPIS_TEMP_POLL_SECONDS: '0.05',
      ELPIS_BUILD_MIN_FREE_GB: '0', ELPIS_BUILD_ABORT_FREE_GB: '0',
      ELPIS_TEST_THREADS: '', INSTA_FORCE_PASS: '', ELPIS_BUILD_REPO_ROOT: '', ...extraEnv },
  });
  const sink = { stdout: '', stderr: '' };
  child.stdout.on('data', (d) => { sink.stdout += d; });
  child.stderr.on('data', (d) => { sink.stderr += d; });
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const read = (name) => (fs.existsSync(path.join(sim, name)) ? fs.readFileSync(path.join(sim, name), 'utf8') : '');
  const pid = (name) => Number(read(name).trim()) || 0;
  const alive = (p) => { try { process.kill(p, 0); return true; } catch { return false; } };
  const ticks = () => read('ticks').split('\n').filter(Boolean).length;
  const cleanup = () => {
    for (const p of [pid('cargo.pid'), pid('child.pid')]) if (p && alive(p)) process.kill(p, 'SIGKILL');
    child.kill('SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, child, sink, exited, setSensor, sensorFile, pid, alive, ticks, cleanup };
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what, condition, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleepMs(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}
async function withSim(options, body) {
  const sim = startSim(options);
  try {
    await until('the build to tick', () => sim.ticks() >= 3);
    await body(sim);
  } finally {
    sim.cleanup();
  }
}
const ownedGone = (sim) => until('owned processes to be gone',
  () => !sim.alive(sim.pid('cargo.pid')) && !sim.alive(sim.pid('child.pid')));
async function assertFailedClosed(sim, status) {
  const code = await Promise.race([sim.exited, sleepMs(3000).then(() => 'still running')]);
  assert.equal(code, 75, sim.sink.stdout + sim.sink.stderr);
  assert.match(sim.sink.stdout, new RegExp(`build_result status=${status} `));
  await ownedGone(sim);
}

test('simulation: pauses 3 C below the limit and resumes only after a 6 C margin', async () => {
  await withSim({}, async (sim) => {
    sim.setSensor(71000);
    await sleepMs(300);
    assert.doesNotMatch(sim.sink.stderr, /thermal_pause/);
    sim.setSensor(72000);
    await until('thermal_pause', () => /thermal_pause/.test(sim.sink.stderr));
    await sleepMs(200);
    const frozen = sim.ticks();
    await sleepMs(300);
    assert.equal(sim.ticks(), frozen, 'build advanced while paused');
    sim.setSensor(70000);
    await sleepMs(300);
    assert.equal(sim.ticks(), frozen, 'build resumed inside the hysteresis band');
    sim.setSensor(68000);
    await until('thermal_resume', () => /thermal_resume/.test(sim.sink.stderr));
    await until('progress after resume', () => sim.ticks() > frozen);
  });
});

test('simulation: reaching the limit while paused stops the build instead of resuming it later', async () => {
  await withSim({}, async (sim) => {
    sim.setSensor(72000);
    await until('thermal_pause', () => /thermal_pause/.test(sim.sink.stderr));
    sim.setSensor(75000);
    await assertFailedClosed(sim, 'thermal_limit');
  });
});

test('simulation: reaching the limit while running stops the build and its children', async () => {
  await withSim({}, async (sim) => {
    sim.setSensor(76000);
    await assertFailedClosed(sim, 'thermal_limit');
  });
});

test('simulation: losing any sensor that was readable at the start stops the build', async () => {
  await withSim({ sensors: 2 }, async (sim) => {
    fs.unlinkSync(sim.sensorFile(2));
    await assertFailedClosed(sim, 'temperature_unavailable');
  });
});

test('simulation: losing every sensor stops the build and its children', async () => {
  await withSim({}, async (sim) => {
    fs.unlinkSync(sim.sensorFile(1));
    await assertFailedClosed(sim, 'temperature_unavailable');
  });
});

test('simulation: a hangup terminates the owned build', async () => {
  await withSim({}, async (sim) => {
    sim.child.kill('SIGHUP');
    await sim.exited;
    await ownedGone(sim);
  });
});

test('polling interval must be a short positive decimal', () => {
  for (const poll of ['0', '0.0', 'abc', '-1', '1e3', '0.01', '5', '1.5.2']) {
    const result = runGuard(50000, 'core-check', undefined, { ELPIS_TEMP_POLL_SECONDS: poll });
    assert.equal(result.status, 2, `${poll}: ${result.stdout}${result.stderr}`);
    assert.equal(result.compilerStarted, false, poll);
  }
  const ok = runGuard(50000, 'core-check', undefined, { ELPIS_TEMP_POLL_SECONDS: '0.25' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
});
