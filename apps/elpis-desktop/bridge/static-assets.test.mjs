import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDesktopServer } from './server.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const files = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);

// 22 Oct: the avatars were packaged but showed as broken pictures, because the real server answered a .webp file with "Unsupported asset"
// (the UI fixture has its own static server, so only a test at this boundary sees it). Whatever the renderer ships in public/ must be served.
test('the server serves every kind of file the renderer ships in public/', async t => {
  const client = { on() {}, off() {}, close() {}, connected: true, pendingApprovals: [], ragEnvironment: async () => ({}) };
  const app = await startDesktopServer({ client, staticDir: publicDir }); t.after(() => app.close());
  const url = new URL(app.url), origin = url.origin, token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const byExtension = new Map(files(publicDir).map(file => [path.extname(file), file]));
  for (const [extension, file] of byExtension) {
    const response = await fetch(origin + '/' + path.relative(publicDir, file).split(path.sep).map(encodeURIComponent).join('/'), { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, `${extension} (${path.relative(publicDir, file)}) is served`);
  }
});
