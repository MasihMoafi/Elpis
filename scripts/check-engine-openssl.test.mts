import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createTestTempDir, removeTestTempDir } from '../tools/elpis-claude/test/temp-root.mts';

test('TLS smoke check distinguishes HTTP authentication from certificate failures and incidental IDs', t => {
  const root = createTestTempDir(path.join(tmpdir(), 'elpis-tls-output-'));
  t.after(() => removeTestTempDir(root));
  for (const [name, normal, control, accepted] of [
    ['certificate rejection with 401 in session ID', 'ERROR: unexpected status 401 Unauthorized', 'session id: 01a1e2a1-2b0e-73b3-818a-3c1ddf4017da\nFailed to load CA certificates: no certificates found in PEM file', true],
    ['no authenticated HTTP response', 'ERROR: connection reset by peer', 'Failed to load CA certificates', false],
    ['certificate control reaches HTTP', 'ERROR: unexpected status 401 Unauthorized', 'ERROR: unexpected status 401 Unauthorized', false],
  ] as const) {
    const engine = path.join(root, `engine-${accepted}-${name.length}`);
    writeFileSync(engine, `#!/bin/bash\nif [[ -n "\${SSL_CERT_FILE:-}" ]]; then\ncat <<'CONTROL'\n${control}\nCONTROL\nelse\ncat <<'NORMAL'\n${normal}\nNORMAL\nfi\n`, { mode: 0o755 });
    const result = spawnSync('bash', ['scripts/check-engine-openssl.sh', '--tls', engine, name], { encoding: 'utf8' });
    assert.equal(result.status === 0, accepted, `${name}\n${result.stdout}\n${result.stderr}`);
  }
});
