import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const productionFiles = [
  'bridge/client.mjs', 'bridge/elpis-features.mjs', 'bridge/provider-keys.mjs', 'bridge/provider-settings.mjs', 'bridge/provider-models.mjs',
  'bridge/rag-command.mjs', 'bridge/server.mjs', 'bridge/tools.mjs', 'bridge/transcription.mjs', 'bridge/attachments.mjs',
  'bridge/resources/rag.md', 'desktop/browser-policy.cjs', 'desktop/browser.cjs',
  'desktop/main.cjs', 'desktop/media-policy.cjs', 'desktop/preload.cjs', 'desktop/files.cjs',
  'desktop/runtime.mjs', 'desktop/state.cjs', 'desktop/elpis-icon.png', 'lib/turn-replacement.ts', 'lib/thread-deletion.ts',
];

const launcher = `#!/usr/bin/env bash
set -euo pipefail
PACKAGE_DIR="$(cd -- "$(dirname -- "$(readlink -f -- "\${BASH_SOURCE[0]}")")" && pwd)"
NODE_BIN="\${ELPIS_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" && -x /usr/local/node/bin/node ]]; then NODE_BIN=/usr/local/node/bin/node; fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  printf 'Elpis requires Node.js. Set ELPIS_NODE_BIN to its executable.\\n' >&2
  exit 1
fi
export ELPIS_NODE_BIN="$NODE_BIN"
export PATH="$(dirname -- "$NODE_BIN"):\${PATH:-/usr/local/bin:/usr/bin:/bin}"
if [[ -n "\${HTTPS_PROXY:-}\${HTTP_PROXY:-}\${ALL_PROXY:-}\${https_proxy:-}\${http_proxy:-}\${all_proxy:-}" ]]; then
  export NODE_USE_ENV_PROXY=1
  bypass="\${NO_PROXY:-\${no_proxy:-}}"
  for host in localhost 127.0.0.1 ::1; do
    case ",$bypass," in *",$host,"*) ;; *) bypass="\${bypass:+$bypass,}$host" ;; esac
  done
  export NO_PROXY="$bypass" no_proxy="$bypass"
fi
unset ELECTRON_RUN_AS_NODE
cd "$PACKAGE_DIR/app"
exec "$PACKAGE_DIR/runtime/electron/electron" "$PACKAGE_DIR/app" "$@"
`;

function requireFile(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`Source symbolic link is not allowed: ${file}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${file}`);
  return stat;
}

function sha256(file) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, 'r');
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function inputFile(file, destination) {
  const stat = requireFile(file);
  return { source: file, path: destination, bytes: stat.size, mode: stat.mode & 0o777, sha256: sha256(file) };
}

function inputTree(directory, destination) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`Source symbolic link is not allowed: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`Expected a directory: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const source = path.join(directory, entry.name);
    const target = path.posix.join(destination, entry.name);
    return entry.isDirectory() ? inputTree(source, target) : [inputFile(source, target)];
  });
}

// Resolve existing parent symlinks before checking whether a new destination overlaps an input.
function resolveDestination(file) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error(`Destination already exists: ${file}`);
  const suffix = [];
  let parent = file;
  while (!fs.existsSync(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...suffix);
}

/** Copy a built renderer and the exact desktop runtime closure. Never builds, installs pointers, or starts the app. */
export function stageDesktop({ source = fileURLToPath(new URL('../', import.meta.url)), destination, electronDist, wsDirectory } = {}) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('An absolute destination is required');
  const target = resolveDestination(path.resolve(destination));
  source = fs.realpathSync(source);
  const electron = fs.realpathSync(electronDist || path.join(source, 'node_modules/electron/dist'));
  const ws = fs.realpathSync(wsDirectory || path.join(source, 'node_modules/ws'));
  for (const input of [source, electron, ws]) {
    const relative = path.relative(input, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error(`Destination is inside a package input: ${input}`);
    }
  }
  requireFile(path.join(source, 'out/index.html'));
  const executable = requireFile(path.join(electron, 'electron'));
  if (!(executable.mode & 0o111)) throw new Error('Electron executable is not executable');
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) requireFile(path.join(electron, name));
  requireFile(path.join(ws, 'LICENSE'));
  requireFile(path.join(source, 'package.json'));
  requireFile(path.join(ws, 'package.json'));
  const identity = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const wsIdentity = JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));
  if (typeof identity.name !== 'string' || typeof identity.version !== 'string' || wsIdentity.name !== 'ws' || typeof wsIdentity.version !== 'string') {
    throw new Error('Desktop or ws package identity is invalid');
  }
  const files = [
    ...productionFiles.map(name => inputFile(path.join(source, name), `app/${name}`)),
    ...inputTree(path.join(source, 'out'), 'app/out'),
    ...inputTree(electron, 'runtime/electron'),
    ...inputTree(ws, 'app/node_modules/ws'),
  ];
  const packageIdentity = { name: identity.name, productName: identity.productName || 'Elpis', version: identity.version,
    private: true, type: 'module', main: 'desktop/main.cjs', dependencies: { ws: wsIdentity.version } };
  const generated = [
    { path: 'app/package.json', data: `${JSON.stringify(packageIdentity, null, 2)}\n`, mode: 0o644 },
    { path: 'launch', data: launcher, mode: 0o755 },
  ];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target); // Exclusive creation: never overwrite another installation.
  for (const file of files) {
    const output = path.join(target, file.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(file.source, output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, file.mode);
    if (sha256(output) !== file.sha256) throw new Error(`Source changed while packaging: ${file.source}`);
  }
  for (const file of generated) {
    const output = path.join(target, file.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, file.data, { flag: 'wx', mode: file.mode });
    files.push({ path: file.path, generated: true, bytes: Buffer.byteLength(file.data), mode: file.mode, sha256: sha256(output) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), source, entryPoint: 'launch',
    fileCount: files.length, payloadBytes: files.reduce((sum, file) => sum + file.bytes, 0), files,
    externalRequirements: ['Node.js selected by ELPIS_NODE_BIN, PATH or /usr/local/node/bin/node',
      'Installed Elpis engine and provider bridge', 'Optional configured command-line tools'] };
  const manifestPath = path.join(target, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { destination: target, launcher: path.join(target, 'launch'), manifest: manifestPath,
    fileCount: files.length + 1, payloadBytes: manifest.payloadBytes, totalBytes: manifest.payloadBytes + fs.statSync(manifestPath).size,
    wsVersion: wsIdentity.version };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({ options: { destination: { type: 'string' }, source: { type: 'string' },
      'electron-dist': { type: 'string' }, 'ws-directory': { type: 'string' } } });
    const result = stageDesktop({ source: values.source, destination: values.destination,
      electronDist: values['electron-dist'], wsDirectory: values['ws-directory'] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
