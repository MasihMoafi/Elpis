import { createTestTempDir, removeTestTempDir } from './temp-root.cjs';
// Native region capture through the production window factory and preload; fake engine, private profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url), { fixture } = require('./parity-fixture.cjs');
const { _electron } = require(process.env.ELPIS_PLAYWRIGHT_PACKAGE || 'playwright');
const appRoot = fileURLToPath(new URL('..', import.meta.url));
const cache = path.join(os.homedir(), '.cache/elpis-tests'); await fs.mkdir(cache, { recursive: true });
const profile = createTestTempDir(path.join(cache, 'improve-capture-'));
const f = await fixture(); let desktop;
try {
  const executablePath = path.join(appRoot, 'node_modules/electron/dist', (await fs.readFile(path.join(appRoot, 'node_modules/electron/path.txt'), 'utf8')).trim());
  desktop = await _electron.launch({ executablePath, args: ['--no-sandbox', path.join(appRoot, 'tests/session-windows-electron.cjs')], env: { ...process.env, ELPIS_HOME: path.join(profile, 'runtime'), SESSION_WINDOW_PROFILE: profile, SESSION_WINDOW_URL: f.page.url() } });
  const page = await desktop.firstWindow(); await page.locator('.app-shell').waitFor();
  const result = await page.evaluate(async () => {
    const region = document.querySelector('aside.sidebar button'), box = region.getBoundingClientRect();
    const image = await window.elpisDesktop.improve.capture({ x: box.x, y: box.y, width: box.width, height: box.height });
    return { ...image, box: { width: box.width, height: box.height }, dpr: devicePixelRatio, source: region.getAttribute('data-elpis-source') };
  });
  assert.match(result.source, /app\/page.tsx#/);
  const bytes = Buffer.from(result.image.split(',')[1], 'base64');
  const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.ok(Math.abs(size.width - result.box.width * result.dpr) <= 2, JSON.stringify({ ...result, image: undefined, size }));
  assert.ok(Math.abs(size.height - result.box.height * result.dpr) <= 2);
  await fs.writeFile('/tmp/elpis-improve-native-region.png', bytes);
  process.stdout.write(`PASS: native source provenance and region capture ${size.width}×${size.height}\n`);
} finally { await desktop?.close(); await f.close(); removeTestTempDir(profile); }
