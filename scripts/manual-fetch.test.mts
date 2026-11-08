import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestTempDir, removeTestTempDir } from '../apps/elpis-desktop/tests/temp-root.cts';

const execute = promisify(execFile);
const manual = '# Fixture manual\n\n## Run locally\nUse the local fixture.\n```md\n## Not a heading\n```\n## Cache\nKeep the verified copy.\n';
const digest = createHash('sha256').update(manual).digest('hex');

for (const entry of ['codex-rs/skills/assets-src/openai-docs/fetch-codex-manual.mts', 'codex-rs/skills/src/assets/samples/openai-docs/scripts/fetch-codex-manual.mjs']) {
  test(`${path.extname(entry)} manual CLI keeps its cache, outline and hash-integrity behavior offline`, async t => {
    const directory = createTestTempDir(path.join(os.tmpdir(), 'manual-cli-'));
    t.after(() => removeTestTempDir(directory));
    const requests: string[] = [];
    const server = http.createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader('x-content-sha256', digest);
      response.end(request.method === 'HEAD' ? undefined : request.url === '/bad' ? 'damaged' : manual);
    });
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const script = fileURLToPath(new URL(`../${entry}`, import.meta.url));
    const run = (route = '/manual', cache = path.join(directory, 'cache')) => execute(process.execPath,
      [script, '--manual-url', url + route, '--cache-dir', cache, '--status-json'],
      { env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '' } });
    const status = (stderr: string) => JSON.parse(stderr.trim().split('\n').at(-1)!) as { cacheStatus: string; manualHashMatches: boolean; headingCount: number; manualPath: string; outlinePath: string };
    const first = await run(), saved = status(first.stderr);
    assert.equal(saved.cacheStatus, 'updated');
    assert.equal(saved.manualHashMatches, true);
    assert.equal(saved.headingCount, 2);
    assert.equal(await fs.readFile(saved.manualPath, 'utf8'), manual);
    assert.match(await fs.readFile(saved.outlinePath, 'utf8'), /Run locally/);
    assert.equal(status((await run()).stderr).cacheStatus, 'hit');
    assert.deepEqual(requests, ['HEAD /manual', 'GET /manual', 'HEAD /manual']);
    await assert.rejects(run('/bad', path.join(directory, 'bad')), /did not match the fetched manual body/);
    await assert.rejects(fs.readFile(path.join(directory, 'bad/codex-manual.md')), { code: 'ENOENT' });
  });
}
