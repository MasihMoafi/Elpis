import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { productionFiles, stageDesktop } from './package.mjs';

const run = promisify(execFile);
const production = productionFiles;

// A file the app imports but the package leaves out stops the installed app at start (16 Oct: preferences.cjs, provider-keys.mjs).
test('the package holds every local file its entry points import', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url)), seen = new Set(), pending = ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/runtime.mjs', 'bridge/server.mjs', 'bridge/client.mjs'];
  while (pending.length) {
    const name = pending.pop(); if (seen.has(name)) continue; seen.add(name);
    const text = (await fs.readFile(path.join(root, name), 'utf8')).replace(/^import type .*;$/gm, '');
    for (const [, target] of text.matchAll(/(?:require\(|from |import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)) pending.push(path.posix.normalize(path.posix.join(path.posix.dirname(name), target)));
  }
  for (const name of seen) assert(production.includes(name), `${name} is imported but not packaged`);
});

async function put(file, data, mode) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data, mode ? { mode } : undefined);
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-package-'));
  const source = path.join(root, 'source');
  const electronDist = path.join(root, 'electron-dist');
  const node = path.join(root, 'canonical-node', 'node');
  const wsReal = path.join(root, 'old-install', 'ws');
  const wsDirectory = path.join(source, 'node_modules', 'ws');
  const ptyReal = path.join(root, 'terminal-deps', 'node-pty');
  const ptyDirectory = path.join(source, 'node_modules', 'node-pty');
  for (const name of production) await put(path.join(source, name), `fixture ${name}\n`);
  await put(path.join(source, 'out', 'index.html'), '<p>Built renderer</p>');
  await put(path.join(source, 'out', '_next', 'static', 'app.js'), 'renderer();');
  await put(path.join(source, 'package.json'), JSON.stringify({ name: 'elpis-desktop', desktopName: 'elpis-desktop.desktop',
    productName: 'Elpis', version: '0.1.0', main: 'desktop/main.cjs',
    scripts: { build: 'next build' }, dependencies: { next: '16.2.6', ws: '8.18.3' } }));
  await put(path.join(source, '.next', 'cache', 'junk'), 'not runtime');
  await put(path.join(source, 'app', 'page.tsx'), 'not runtime');
  await put(path.join(source, 'node_modules', 'next', 'junk'), 'not runtime');
  await put(path.join(source, 'desktop', 'main.test.cjs'), 'not runtime');
  await put(path.join(source, 'desktop', 'launch.sh'), '#!/bin/bash\nexit 99\n', 0o755);
  await put(node, '#!/bin/bash\nexit 0\n', 0o755);
  await put(path.join(electronDist, 'electron'), `#!/bin/bash
set -euo pipefail
if [[ "\${ELECTRON_RUN_AS_NODE:-}" == 1 ]]; then
  printf 'node-mode=%s\\nargument=%s\\n' "$ELECTRON_RUN_AS_NODE" "\${1:-}"
  exit 0
fi
test -f "$1/out/index.html"
test -f "$1/desktop/main.cjs"
printf 'app=%s\\nargument=%s\\nnode-bin=%s\\nnode-mode=%s\\npath-first=%s\\nno-proxy=%s\\nno-proxy-lower=%s\\nproxy-mode=%s\\n' "$1" "\${2:-}" "$ELPIS_NODE_BIN" "\${ELECTRON_RUN_AS_NODE:-}" "\${PATH%%:*}" "\${NO_PROXY:-}" "\${no_proxy:-}" "\${NODE_USE_ENV_PROXY:-}"
`, 0o755);
  for (const name of ['LICENSE', 'LICENSES.chromium.html', 'locales/en-US.pak', 'libEGL.so', 'chrome-sandbox']) {
    await put(path.join(electronDist, name), `electron ${name}`, name === 'chrome-sandbox' ? 0o755 : undefined);
  }
  await put(path.join(wsReal, 'package.json'), JSON.stringify({ name: 'ws', version: '8.22.0', main: 'index.js' }));
  await put(path.join(wsReal, 'index.js'), 'module.exports = {};');
  await put(path.join(wsReal, 'lib', 'websocket.js'), 'module.exports = {};');
  await put(path.join(wsReal, 'LICENSE'), 'ws license');
  await fs.mkdir(path.dirname(wsDirectory), { recursive: true });
  await fs.symlink(wsReal, wsDirectory);
  // The integrated terminal's native module: only its loader, licence and Linux build are shipped.
  await put(path.join(ptyReal, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0', main: './lib/index.js' }));
  for (const name of ['LICENSE', 'lib/index.js', 'lib/unixTerminal.js', 'build/Release/pty.node']) await put(path.join(ptyReal, name), `node-pty ${name}`);
  for (const name of ['lib/index.test.js', 'lib/index.js.map', 'prebuilds/darwin-x64/pty.node', 'src/unix/pty.cc', 'build/Release/obj.target/pty.node']) await put(path.join(ptyReal, name), 'not runtime');
  await fs.symlink(ptyReal, ptyDirectory);
  return { root, source, electronDist, wsDirectory, ptyDirectory, node, destination: path.join(root, 'staged') };
}

async function inventory(directory, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `package must not depend on a symlink: ${name}`);
    if (entry.isDirectory()) files.push(...await inventory(directory, name));
    else files.push(name);
  }
  return files.sort();
}

test('production package runs after its source and dependency installations move', async () => {
  const options = await fixture();
  const result = stageDesktop(options);
  const all = await inventory(options.destination);
  for (const name of production) assert(all.includes(`app/${name}`), name);
  assert(all.includes('runtime/electron/LICENSES.chromium.html'));
  assert(all.includes('runtime/electron/locales/en-US.pak'));
  assert(all.includes('app/node_modules/ws/LICENSE'));
  for (const name of ['package.json', 'LICENSE', 'lib/index.js', 'lib/unixTerminal.js', 'build/Release/pty.node']) assert(all.includes(`app/node_modules/node-pty/${name}`), name);
  assert.deepEqual(all.filter(name => name.startsWith('app/node_modules/node-pty/')).length, 5, 'node-pty ships without its tests, maps, sources or other platforms');
  assert(!all.some(name => /(^|\/)(\.next|tests?|next)(\/|$)|\.test\./.test(name)));
  assert(!all.includes('app/desktop/launch.sh'));
  const identity = JSON.parse(await fs.readFile(path.join(options.destination, 'app/package.json'), 'utf8'));
  assert.equal(identity.name, 'elpis-desktop');
  assert.equal(identity.desktopName, 'elpis-desktop.desktop', 'the window is matched to its launcher entry and icon');
  assert.equal(identity.main, 'desktop/main.cjs');
  assert.equal(identity.type, 'module');
  assert.deepEqual(identity.dependencies, { ws: '8.22.0', 'node-pty': '1.1.0' });
  assert.equal(identity.scripts, undefined);
  const manifest = JSON.parse(await fs.readFile(result.manifest, 'utf8'));
  assert(manifest.externalRequirements.some(requirement => requirement.startsWith('Node.js')));
  assert.equal(manifest.fileCount, all.length - 1);
  let bytes = 0;
  for (const file of manifest.files) {
    const contents = await fs.readFile(path.join(options.destination, file.path));
    assert.equal(createHash('sha256').update(contents).digest('hex'), file.sha256, file.path);
    assert.equal(contents.length, file.bytes);
    bytes += contents.length;
  }
  assert.equal(bytes, manifest.payloadBytes);
  // A copy of the app carries no path from the machine that built it.
  assert.ok(!JSON.stringify(manifest).includes(options.source), 'the manifest names no source folder');
  assert.ok(!JSON.stringify(manifest).includes(os.homedir()), 'the manifest names no home folder');
  assert.equal(result.totalBytes, bytes + (await fs.stat(result.manifest)).size);
  await fs.rename(options.source, `${options.source}-moved`);
  await fs.rename(path.join(options.root, 'old-install'), path.join(options.root, 'old-install-moved'));
  await fs.rename(options.electronDist, `${options.electronDist}-moved`);
  const entry = path.join(options.root, 'app menu', 'elpis-app');
  await fs.mkdir(path.dirname(entry));
  await fs.symlink(path.join(options.destination, 'launch'), entry);
  const launched = await run(entry, ['argument with spaces'], {
    env: { PATH: '/usr/bin:/bin', ELPIS_NODE_BIN: options.node, HTTPS_PROXY: 'http://proxy.invalid:1234', NO_PROXY: 'example.test',
      ELECTRON_RUN_AS_NODE: '1' },
  });
  const fields = Object.fromEntries(launched.stdout.trim().split('\n').map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
  assert.equal(fields.app, path.join(options.destination, 'app'));
  assert.equal(fields.argument, 'argument with spaces');
  assert.equal(fields['node-bin'], options.node);
  assert.equal(fields['node-mode'], '');
  assert.equal(fields['path-first'], path.dirname(options.node));
  assert.equal(fields['proxy-mode'], '1');
  assert.equal(fields['no-proxy'], 'example.test,localhost,127.0.0.1,::1');
  assert.equal(fields['no-proxy-lower'], fields['no-proxy']);
  const inherited = await run(path.join(options.destination, 'launch'), [], { env: { PATH: `${path.dirname(options.node)}:/usr/bin:/bin` } });
  assert(inherited.stdout.includes(`node-bin=${options.node}\n`));
  await assert.rejects(run(path.join(options.destination, 'launch'), [], { env: { PATH: '/usr/bin:/bin', ELPIS_NODE_BIN: '/missing/node' } }), /Elpis requires Node\.js/);
});

test('packager refuses an existing destination and preserves its contents', async () => {
  const options = await fixture();
  await put(path.join(options.destination, 'keep'), 'existing installation');
  assert.throws(() => stageDesktop(options), /destination.*exist/i);
  assert.equal(await fs.readFile(path.join(options.destination, 'keep'), 'utf8'), 'existing installation');
});

test('missing renderer or Electron licenses cannot produce an installation', async () => {
  for (const missing of ['out/index.html', 'LICENSES.chromium.html']) {
    const options = await fixture();
    const file = missing.startsWith('out/') ? path.join(options.source, missing) : path.join(options.electronDist, missing);
    await fs.rename(file, `${file}-missing`);
    assert.throws(() => stageDesktop(options), /index\.html|LICENSES\.chromium\.html/);
    await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
  }
});

test('packager rejects source links instead of depending on another installation', async () => {
  const options = await fixture();
  await fs.symlink(path.join(options.source, 'app/page.tsx'), path.join(options.source, 'out/leaked-source'));
  assert.throws(() => stageDesktop(options), /symlink|symbolic link/i);
  await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
});

test('packager rejects a destination inside its inputs', async () => {
  const options = await fixture();
  options.destination = path.join(options.electronDist, 'nested');
  assert.throws(() => stageDesktop(options), /inside|overlap/i);
  await assert.rejects(fs.stat(options.destination), { code: 'ENOENT' });
});

test('command-line packaging emits its receipt without launching the desktop', async () => {
  const options = await fixture();
  const result = await run(process.execPath, [fileURLToPath(new URL('./package.mjs', import.meta.url)),
    '--source', options.source, '--destination', options.destination,
    '--electron-dist', options.electronDist, '--ws-directory', options.wsDirectory, '--pty-directory', options.ptyDirectory]);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.destination, options.destination);
  assert.equal(receipt.launcher, path.join(options.destination, 'launch'));
  assert(receipt.totalBytes > 0);
  assert.equal(receipt.wsVersion, '8.22.0');
  assert.equal(result.stderr, '');
});
