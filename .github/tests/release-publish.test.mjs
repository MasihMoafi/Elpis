import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../workflows/embedded-elpis-linux.yml', import.meta.url), 'utf8');
function stepScript(name) {
  const step = workflow.split(`      - name: ${name}\n`)[1];
  assert.ok(step, `missing step: ${name}`);
  const block = step.split('        run: |\n')[1];
  assert.ok(block, `missing script: ${name}`);
  const lines = block.split('\n');
  const end = lines.findIndex(line => line && !line.startsWith('          '));
  return lines.slice(0, end < 0 ? undefined : end).map(line => line.slice(10)).join('\n');
}

const oldCommit = '1'.repeat(40);
const newCommit = '2'.repeat(40);
const fakeGh = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  'api repos/test/Elpis/releases/latest') echo "\${FAKE_LATEST:-v0.2.0}" ;;
  'api repos/test/Elpis/git/ref/tags/v0.2.0')
    case "$4" in
      .object.type) echo commit ;;
      .object.sha) echo "$FAKE_OLD_COMMIT" ;;
      *) exit 2 ;;
    esac ;;
  'release view') test "\${FAKE_RELEASE_EXISTS:-true}" = true ;;
  'release upload')
    shift 3
    while [[ "$1" != --* ]]; do cp "$1" "$FAKE_ASSETS/"; shift; done ;;
  'release download')
    shift 3
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --repo) shift 2 ;;
        --pattern) asset=$2; shift 2 ;;
        --dir) dest=$2; shift 2 ;;
        *) exit 2 ;;
      esac
    done
    cp "$FAKE_ASSETS/$asset" "$dest/$asset"
    if [ "\${FAKE_CORRUPT:-false}" = true ]; then echo corrupt >> "$dest/$asset"; fi ;;
  'api --method'|'release edit'|'release create') ;;
  *) echo "unexpected gh invocation" >&2; exit 2 ;;
esac
`;

function runPublish(overrides = {}) {
  const work = mkdtempSync(join(tmpdir(), 'elpis-release-test-'));
  try {
    for (const path of ['bin', 'dist', 'assets', 'codex-rs/tui', '.github']) mkdirSync(join(work, path), { recursive: true });
    writeFileSync(join(work, 'bin/gh'), fakeGh);
    writeFileSync(join(work, 'bin/dpkg-deb'), '#!/usr/bin/env bash\ncase "$3" in Package) echo elpis;; Version) echo 0.2.0-1;; *) exit 2;; esac\n');
    for (const name of ['gh', 'dpkg-deb']) chmodSync(join(work, 'bin', name), 0o755);
    writeFileSync(join(work, 'codex-rs/tui/Cargo.toml'), '[package]\nversion = "0.2.0"\n');
    writeFileSync(join(work, '.github/RELEASE_NOTES.md'), '# Refreshed evidence links\n');
    writeFileSync(join(work, 'dist/elpis'), 'fixed-binary');
    writeFileSync(join(work, 'dist/elpis_0.2.0-1_amd64.deb'), 'fixed-deb');
    writeFileSync(join(work, 'gh.log'), '');
    const result = spawnSync('bash', ['-c', stepScript('Publish GitHub release')], {
      cwd: work,
      encoding: 'utf8',
      env: {
        PATH: `${join(work, 'bin')}:${process.env.PATH}`,
        REPLACE_EXISTING_RELEASE: 'true', FULL_REGRESSION: 'true', EXPECTED_RELEASE_COMMIT: oldCommit,
        GITHUB_REF_NAME: 'v0.2.0', GITHUB_REPOSITORY: 'test/Elpis', GITHUB_SHA: newCommit,
        GITHUB_RUN_ID: '123', RUNNER_TEMP: work, TMPDIR: work,
        FAKE_OLD_COMMIT: oldCommit, FAKE_LOG: join(work, 'gh.log'), FAKE_ASSETS: join(work, 'assets'),
        ...overrides,
      },
    });
    return { ...result, log: readFileSync(join(work, 'gh.log'), 'utf8') };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

test('maintenance replacement uploads and verifies all assets before aligning tag and notes', () => {
  const result = runPublish();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /release upload v0\.2\.0 .*--clobber/);
  assert.equal((result.log.match(/release download /g) || []).length, 4);
  assert.match(result.log, new RegExp(`api --method PATCH .* -f sha=${newCommit} -F force=true`));
  assert.match(result.log, /release edit v0\.2\.0 .*--latest/);
  assert.ok(result.log.lastIndexOf('release download') < result.log.indexOf('api --method PATCH'));
  assert.doesNotMatch(result.log, /release create/);
});

for (const [name, overrides] of [
  ['missing exhaustive checks', { FULL_REGRESSION: 'false' }],
  ['invalid expected commit', { EXPECTED_RELEASE_COMMIT: '' }],
  ['changed release tag', { FAKE_OLD_COMMIT: '3'.repeat(40) }],
  ['different latest release', { FAKE_LATEST: 'v0.3.0' }],
  ['normal release overwrite', { REPLACE_EXISTING_RELEASE: 'false' }],
]) {
  test(`refuses ${name} before any release mutation`, () => {
    const result = runPublish(overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.log, /release (upload|edit|create)|api --method PATCH/);
  });
}

test('corrupt download prevents moving the tag or declaring the refresh', () => {
  const result = runPublish({ FAKE_CORRUPT: 'true' });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /release upload/);
  assert.doesNotMatch(result.log, /release edit|api --method PATCH/);
});

test('normal new tag still creates a release without overwrite or tag movement', () => {
  const result = runPublish({ REPLACE_EXISTING_RELEASE: 'false', FAKE_RELEASE_EXISTS: 'false' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /release create v0\.2\.0/);
  assert.doesNotMatch(result.log, /--clobber|api --method PATCH|release edit/);
});

test('replacement preflight rejects omitted full checks before building', () => {
  for (const [full, commit, expectedStatus] of [['true', oldCommit, 0], ['false', oldCommit, 1], ['true', '', 1]]) {
    const result = spawnSync('bash', ['-c', stepScript('Validate maintenance replacement request')], {
      env: { FULL_REGRESSION: full, EXPECTED_RELEASE_COMMIT: commit }, encoding: 'utf8',
    });
    assert.equal(result.status, expectedStatus, result.stderr);
  }
});
