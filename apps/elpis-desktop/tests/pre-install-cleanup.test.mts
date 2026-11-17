import { fileURLToPath } from 'node:url';
// 23 Oct: six test processes the pre-install check had started kept running for up to 24 h and froze Masih's machine. A file that leaves a
// process behind must not outlive the check: everything the file started goes with it.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { smokeEngine, smokeEnvironment, stopSmokeProcesses } from '../scripts/smoke-launch.mts';

const root = fileURLToPath(new URL('../', import.meta.url));
const running = (marker: string) => execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(marker)).length;

test('smoke child writes only to its isolated profile and never inherits the real runtime or credentials', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-smoke-isolation-'));
  const real = path.join(directory, 'real'), scratch = path.join(directory, 'scratch');
  fs.mkdirSync(real); fs.mkdirSync(scratch);
  const sentinel = path.join(real, 'sentinel'); fs.writeFileSync(sentinel, 'unchanged');
  const poisoned = { CODEX_HOME: real, CODEX_AUTH_HOME: real, ELPIS_APP_BRIDGE_SOCKET: '/real/bridge',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/real/bus', HTTP_PROXY: 'http://user:secret@proxy', OPENAI_API_KEY: 'secret' };
  const previous = Object.fromEntries(Object.keys(poisoned).map(key => [key, process.env[key]]));
  Object.assign(process.env, poisoned);
  try {
    const env = smokeEnvironment(scratch);
    const code = `const fs=require('node:fs'),p=require('node:path');
      fs.mkdirSync(process.env.CODEX_HOME,{recursive:true});
      fs.writeFileSync(p.join(process.env.CODEX_HOME,'sentinel'),'child');
      process.stdout.write(JSON.stringify(process.env));`;
    const child = spawnSync(process.execPath, ['-e', code], { env, cwd: env.HOME, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const got = JSON.parse(child.stdout) as Record<string, string>;
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
    assert.equal(fs.readFileSync(path.join(scratch, 'home', 'codex', 'sentinel'), 'utf8'), 'child');
    for (const key of Object.keys(poisoned).filter(key => !['CODEX_HOME', 'CODEX_AUTH_HOME'].includes(key))) assert.equal(got[key], undefined, key);
    for (const key of ['HOME', 'ELPIS_HOME', 'CODEX_HOME', 'CODEX_AUTH_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR'])
      assert.ok(got[key]?.startsWith(`${scratch}/`), key);
    const engine = path.join(real, 'engine'); fs.writeFileSync(engine, 'engine');
    assert.equal(smokeEngine('/package', '/package/launch', { HOME: real, ELPIS_ENGINE_BIN: engine }), engine);
    assert.equal(smokeEngine('/package', '/package/appimage', { HOME: real }), undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('smoke cleanup stops detached descendants without touching a different home', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-smoke-detached-'));
  const env = smokeEnvironment(directory), home = env.HOME!, ready = path.join(directory, 'ready');
  const code = `const {spawn}=require('node:child_process'),fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    child.unref(); fs.writeFileSync(process.argv[1],String(child.pid)); setInterval(()=>{},1000);`;
  const detached = spawn(process.execPath, ['-e', code, ready], { env, detached: true, stdio: 'ignore' });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: { ...env, HOME: `${home}-other` }, detached: true, stdio: 'ignore',
  });
  let descendant = 0;
  try {
    const until = Date.now() + 5000;
    while (!fs.existsSync(ready) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(fs.existsSync(ready), 'detached process started its own detached child');
    descendant = Number(fs.readFileSync(ready, 'utf8'));
    assert.ok(descendant > 0);
    const exited = once(detached, 'exit');
    await stopSmokeProcesses(home);
    await exited;
    // An orphan can remain as a zombie until its new parent reaps it; it is no longer running.
    let state = 'gone';
    try { state = fs.readFileSync(`/proc/${descendant}/stat`, 'utf8').match(/^\d+ \(.*\) (\S)/)?.[1] ?? 'unknown'; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    assert.ok(state === 'gone' || state === 'Z', `detached descendant stopped, state ${state}`);
    assert.doesNotThrow(() => process.kill(unrelated.pid!, 0), 'different HOME remains alive');
  } finally {
    await stopSmokeProcesses(home);
    if (unrelated.exitCode === null && unrelated.signalCode === null) {
      const exited = once(unrelated, 'exit');
      unrelated.kill('SIGKILL');
      await exited;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a test file that leaves a process running does not leave it behind after the check', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-pre-install-')), marker = `${process.pid}${Date.now()}`;
  const file = path.join(directory, 'leaves-a-child.test.mjs');
  fs.writeFileSync(file, `import { spawn } from 'node:child_process'; import { test } from 'node:test';\ntest('passes and leaves a sleeper', () => { spawn('sleep', ['600.${marker}'], { stdio: 'ignore' }).unref(); });\n`);
  try {
    const result = spawnSync(process.execPath, ['scripts/pre-install.mts'], { cwd: root, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')), ELPIS_CHECK_FILES: file, ELPIS_CHECK_JOBS: '1' }, encoding: 'utf8', timeout: 60_000 });
    assert.match(result.stdout, /1 of 1 files pass/);
    assert.equal(running(`600.${marker}`), 0, 'the sleeper the file started is gone');
  } finally {
    spawnSync('pkill', ['-f', `600.${marker}`]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
