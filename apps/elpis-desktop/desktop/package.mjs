import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

/** Every file the packaged app loads besides the renderer; package.test.mjs checks it against their imports. */
export const productionFiles = [
  'bridge/improve.mjs', 'bridge/improve-source.mjs', 'bridge/improve-check.mjs', 'desktop/improve.cjs',
  'bridge/browser-mcp.mjs', 'desktop/browser-agent.cjs',
  'bridge/canvas-plan.mjs', 'bridge/experiment-lab.mjs', 'bridge/client.mjs', 'bridge/customize.mjs', 'bridge/skill-trash.mjs', 'bridge/github-connector.mjs', 'bridge/elpis-features.mjs', 'bridge/observability.mjs', 'bridge/smart-prune.mjs', 'bridge/files.mjs', 'bridge/folders.mjs', 'bridge/git.mjs', 'bridge/recorded-changes.mjs', 'bridge/provider-keys.mjs', 'bridge/provider-settings.mjs', 'bridge/provider-models.mjs',
  'bridge/rag-command.mjs', 'bridge/rewind-history.mjs', 'bridge/rewind-snapshots.mjs', 'bridge/server.mjs', 'bridge/dev-servers.mjs', 'bridge/tools.mjs', 'bridge/runtime-paths.mjs', 'bridge/transcription.mjs', 'bridge/attachments.mjs', 'bridge/trash.mjs',
  'bridge/resources/rag.md', 'bridge/resources/personal.md', 'bridge/personal.mjs', 'bridge/session-manager-mcp.mjs', 'bridge/session-manager-monitor.mjs', 'desktop/session-manager-agent.cjs', 'desktop/browser-policy.cjs', 'desktop/browser.cjs', 'desktop/browser-sessions.cjs', 'desktop/browser-annotations.cjs', 'desktop/browser-page-preload.cjs', 'desktop/context-menu.cjs',
  'desktop/main.cjs', 'desktop/app-updates.cjs', 'desktop/wayland-ime.cjs', 'desktop/session-windows.cjs', 'desktop/window-ipc.cjs', 'desktop/media-policy.cjs', 'desktop/preferences.cjs', 'desktop/preload.cjs', 'desktop/files.cjs', 'desktop/editors.cjs',
  'desktop/terminal.cjs', 'desktop/open-thread.cjs', 'desktop/tray.cjs', 'desktop/quick-entry.cjs', 'desktop/theme.cjs', 'desktop/copy-keys.cjs', 'desktop/quick-entry-preload.cjs', 'desktop/quick-entry.html',
  'desktop/runtime.mjs', 'desktop/state.cjs', 'desktop/elpis-icon.png', 'lib/agent-runs.mjs', 'lib/service-tier.mjs', 'lib/chat-worktree.ts', 'lib/turn-replacement.ts', 'lib/thread-deletion.ts', 'lib/approvals.ts', 'bridge/love-spot-store.cjs', 'bridge/love-spot-order.cjs', 'bridge/love-spot-talk.mjs', 'bridge/love-agents.mjs', 'bridge/acp-nodes.mjs', 'bridge/workflow-acp.mjs', 'bridge/workflow-worktrees.mjs', 'lib/love-spot.ts',
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
# Started from the dock, the app lacks the shell's proxy; GNOME's system proxy (set by the VPN app) stands in, in the
# form a terminal exports, so the app and a terminal \`elpis\` share one bridge.
if [[ -z "\${HTTPS_PROXY:-}\${HTTP_PROXY:-}\${ALL_PROXY:-}\${https_proxy:-}\${http_proxy:-}\${all_proxy:-}" ]] && command -v gsettings >/dev/null \
  && [[ "$(gsettings get org.gnome.system.proxy mode 2>/dev/null)" == "'manual'" ]]; then
  gnome_proxy() { local host port; host="$(gsettings get "org.gnome.system.proxy.$1" host 2>/dev/null | tr -d "'")"; port="$(gsettings get "org.gnome.system.proxy.$1" port 2>/dev/null)"; [[ -n "$host" && "\${port:-0}" != 0 ]] && printf '%s://%s:%s/' "$2" "$host" "$port"; }
  web="$(gnome_proxy https http || gnome_proxy http http || true)"; socks="$(gnome_proxy socks socks || true)"
  [[ -n "$web" ]] && export HTTP_PROXY="$web" HTTPS_PROXY="$web" http_proxy="$web" https_proxy="$web"
  [[ -n "$socks" ]] && export ALL_PROXY="$socks" all_proxy="$socks"
  ignore="$(gsettings get org.gnome.system.proxy ignore-hosts 2>/dev/null | tr -d "[]' ")"
  [[ -n "$web$socks" && -n "$ignore" ]] && export NO_PROXY="$ignore" no_proxy="$ignore"
fi
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

function inputTree(directory, destination, keep = () => true) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`Source symbolic link is not allowed: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`Expected a directory: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const source = path.join(directory, entry.name);
    const target = path.posix.join(destination, entry.name);
    if (!keep(target)) return [];
    return entry.isDirectory() ? inputTree(source, target, keep) : [inputFile(source, target)];
  });
}

/** Hard-links `source` to `output`; false when the filesystem refuses (another device, no permission). */
function tryLink(source, output) {
  try { fs.linkSync(source, output); return true; } catch (error) {
    if (['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP'].includes(error.code)) return false;
    throw error;
  }
}

// Resolve existing parent symlinks before checking whether a new destination overlaps an input.
function resolveDestination(file) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error(`Destination already exists: ${file}`);
  const suffix = [];
  let parent = file;
  while (!fs.existsSync(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...suffix);
}

/** Copy a built renderer and the exact desktop runtime closure. Never builds, installs pointers, or starts the app.
 * `outDirectory` is the renderer to ship (default: the source's out/, or one GitHub Actions built). With `linkRuntime`,
 * Electron's files are hard-linked from `electronDist` (an earlier installation's runtime) rather than copied, so an
 * installation adds about 30 MB instead of 310 MB; installations are never changed after staging. */
export function stageDesktop({ source = fileURLToPath(new URL('../', import.meta.url)), destination, electronDist, wsDirectory, ptyDirectory, outDirectory, linkRuntime = false } = {}) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('An absolute destination is required');
  const target = resolveDestination(path.resolve(destination));
  source = fs.realpathSync(source);
  const electron = fs.realpathSync(electronDist || path.join(source, 'node_modules/electron/dist'));
  const ws = fs.realpathSync(wsDirectory || path.join(source, 'node_modules/ws'));
  const pty = fs.realpathSync(ptyDirectory || path.join(source, 'node_modules/node-pty'));
  const out = fs.realpathSync(outDirectory || path.join(source, 'out'));
  for (const input of [source, electron, ws, pty, out]) {
    const relative = path.relative(input, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error(`Destination is inside a package input: ${input}`);
    }
  }
  requireFile(path.join(out, 'index.html'));
  const executable = requireFile(path.join(electron, 'electron'));
  if (!(executable.mode & 0o111)) throw new Error('Electron executable is not executable');
  for (const name of ['LICENSE', 'LICENSES.chromium.html']) requireFile(path.join(electron, name));
  requireFile(path.join(ws, 'LICENSE'));
  requireFile(path.join(source, 'package.json'));
  requireFile(path.join(ws, 'package.json'));
  const identity = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const wsIdentity = JSON.parse(fs.readFileSync(path.join(ws, 'package.json'), 'utf8'));
  const ptyIdentity = JSON.parse(fs.readFileSync(path.join(pty, 'package.json'), 'utf8'));
  if (ptyIdentity.name !== 'node-pty' || typeof ptyIdentity.version !== 'string') throw new Error('node-pty package identity is invalid');
  for (const name of ['LICENSE', 'lib/index.js', 'build/Release/pty.node']) requireFile(path.join(pty, name));
  if (typeof identity.name !== 'string' || typeof identity.version !== 'string' || wsIdentity.name !== 'ws' || typeof wsIdentity.version !== 'string') {
    throw new Error('Desktop or ws package identity is invalid');
  }
  const files = [
    ...productionFiles.map(name => inputFile(path.join(source, name), `app/${name}`)),
    ...inputTree(out, 'app/out'),
    ...inputTree(electron, 'runtime/electron'),
    ...inputTree(ws, 'app/node_modules/ws'),
    // The integrated terminal (desktop/terminal.cjs): node-pty's loader, licence and its build for this Electron.
    ...['package.json', 'LICENSE', 'build/Release/pty.node'].map(name => inputFile(path.join(pty, name), `app/node_modules/node-pty/${name}`)),
    ...inputTree(path.join(pty, 'lib'), 'app/node_modules/node-pty/lib', name => !/\.test\.js$|\.map$/.test(name)),
  ];
  const packageIdentity = { name: identity.name, productName: identity.productName || 'Elpis', desktopName: identity.desktopName, version: identity.version,
    private: true, type: 'module', main: 'desktop/main.cjs', dependencies: { ws: wsIdentity.version, 'node-pty': ptyIdentity.version } };
  const generated = [
    { path: 'app/package.json', data: `${JSON.stringify(packageIdentity, null, 2)}\n`, mode: 0o644 },
    { path: 'launch', data: launcher, mode: 0o755 },
  ];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target); // Exclusive creation: never overwrite another installation.
  for (const file of files) {
    const output = path.join(target, file.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (!(linkRuntime && file.path.startsWith('runtime/') && tryLink(file.source, output))) {
      fs.copyFileSync(file.source, output, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(output, file.mode);
    }
    if (sha256(output) !== file.sha256) throw new Error(`Source changed while packaging: ${file.source}`);
  }
  for (const file of generated) {
    const output = path.join(target, file.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, file.data, { flag: 'wx', mode: file.mode });
    files.push({ path: file.path, generated: true, bytes: Buffer.byteLength(file.data), mode: file.mode, sha256: sha256(output) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  // The manifest names files by their place in the installation only: where they were built from on this machine
  // (the user's folders) never travels with a copy of the app.
  const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), entryPoint: 'launch',
    fileCount: files.length, payloadBytes: files.reduce((sum, file) => sum + file.bytes, 0), files: files.map(({ source: _source, ...file }) => file),
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
      'electron-dist': { type: 'string' }, 'ws-directory': { type: 'string' }, 'pty-directory': { type: 'string' },
      'out-directory': { type: 'string' }, 'link-runtime': { type: 'boolean' } } });
    const result = stageDesktop({ source: values.source, destination: values.destination,
      electronDist: values['electron-dist'], wsDirectory: values['ws-directory'], ptyDirectory: values['pty-directory'],
      outDirectory: values['out-directory'], linkRuntime: values['link-runtime'] });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
