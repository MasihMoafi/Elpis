// 23 Oct: six test processes the pre-install check had started kept running for up to 24 h and froze Masih's machine. A file that leaves a
// process behind must not outlive the check: everything the file started goes with it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url).pathname;
const running = marker => execFileSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).split('\n').filter(line => line.includes(marker)).length;

test('a test file that leaves a process running does not leave it behind after the check', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-pre-install-')), marker = `${process.pid}${Date.now()}`;
  const file = path.join(directory, 'leaves-a-child.test.mjs');
  fs.writeFileSync(file, `import { spawn } from 'node:child_process'; import { test } from 'node:test';\ntest('passes and leaves a sleeper', () => { spawn('sleep', ['600.${marker}'], { stdio: 'ignore' }).unref(); });\n`);
  try {
    const result = spawnSync(process.execPath, ['scripts/pre-install.mjs'], { cwd: root, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')), ELPIS_CHECK_FILES: file, ELPIS_CHECK_JOBS: '1' }, encoding: 'utf8', timeout: 60_000 });
    assert.match(result.stdout, /1 of 1 files pass/);
    assert.equal(running(`600.${marker}`), 0, 'the sleeper the file started is gone');
  } finally {
    spawnSync('pkill', ['-f', `600.${marker}`]);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
