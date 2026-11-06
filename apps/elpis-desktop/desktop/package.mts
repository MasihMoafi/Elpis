import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';

type PackageFile = { source?: string; path: string; bytes: number; mode: number; sha256: string; generated?: boolean };
type Options = { source?: string | undefined; destination?: string | undefined; electronDist?: string | undefined; wsDirectory?: string | undefined; ptyDirectory?: string | undefined; rruleDirectory?: string | undefined; outDirectory?: string | undefined; linkRuntime?: boolean | undefined };

/** Every file the packaged app loads besides the renderer; package.test.mjs checks it against their imports. */
export const productionFiles = [
  'bridge/matilda-companion.mjs',
  'desktop/app-menu.cjs', 'lib/app-menu-commands.cts',
  'bridge/voice.mjs', 'bridge/voice-handoff.cts', 'bridge/kokoro.mjs', 'bridge/read-aloud-provider.mjs', 'lib/speech-model.mts', 'bridge/schedule.mjs', 'bridge/schedule-rules.mjs', 'bridge/schedule-mcp.mts', 'bridge/kokoro-worker.py',
  'bridge/resources/permission-policy.mjs', 'bridge/resources/workflow-concurrency.mjs',
  'bridge/import-chats.mjs',
  'bridge/settings-files.mjs', 'bridge/app-identity.mts', 'desktop/sleep-blocker.cjs',
  'bridge/session-context.mts', 'bridge/side-turn.mjs', 'bridge/thread-titles.mjs',
  'bridge/profile-env.mts', 'lib/love-spot-audio.mts', 'lib/audio-path.mts',
  'bridge/love-interview.mts', 'bridge/agent-output.mjs',
  'bridge/improve.mjs', 'bridge/improve-source.mts', 'bridge/improve-check.mts', 'desktop/improve.cjs',
  'bridge/browser-mcp.mjs', 'bridge/claude-mcp-import.mts', 'desktop/browser-agent.cjs', 'desktop/browser-identity.cts', 'desktop/documents.cjs', 'desktop/screen-capture.cjs',
  'bridge/canvas-plan.mjs', 'bridge/experiment-lab.mjs', 'bridge/client.mjs', 'bridge/subscription-models.mts', 'bridge/cloudroom-vm.mjs', 'bridge/permission-presets.mjs', 'bridge/customize.mjs', 'bridge/skill-trash.mts', 'bridge/github-connector.mjs', 'bridge/elpis-features.mjs', 'bridge/smart-prune.mjs', 'bridge/files.mjs', 'bridge/folders.mjs', 'bridge/git.mjs', 'bridge/recorded-changes.mjs', 'bridge/provider-keys.mjs', 'bridge/provider-settings.mjs', 'bridge/provider-models.mts',
  'bridge/client-state.mjs', 'bridge/client-paths.mjs', 'bridge/client-permissions.mjs', 'bridge/client-protocol.mjs', 'bridge/client-archive-history.mjs',
  'bridge/client-connection.mjs', 'bridge/client-thread-list.mjs', 'bridge/client-thread-actions.mjs',
  'bridge/client-models.mjs', 'bridge/client-settings.mjs', 'bridge/client-voice.mjs', 'bridge/client-mcp.mjs',
  'bridge/client-context.mjs', 'bridge/client-workflows.mjs', 'bridge/client-rewind.mjs', 'bridge/client-turns.mjs',
  'bridge/client-changes.mjs', 'bridge/client-mutation.mjs', 'bridge/client-approvals.mjs',
  'bridge/rag-command.mts', 'bridge/rewind-history.mts', 'bridge/message-versions.mts', 'bridge/rewind-snapshots.mts', 'bridge/spawn-links.mjs', 'bridge/session-creators.mjs', 'bridge/app-catalogs.mts', 'bridge/customize-page.mjs', 'bridge/validate.mts', 'bridge/server.mjs',
  'bridge/server-http.mjs', 'bridge/server-love-spot.mjs', 'bridge/server-voice.mjs', 'bridge/server-files.mjs', 'bridge/server-settings.mjs', 'bridge/server-workflows.mjs', 'bridge/server-threads.mjs',
  'bridge/trajectory-projection.mts', 'bridge/dev-servers.mjs', 'bridge/tools.mjs', 'bridge/runtime-paths.mts', 'bridge/transcription.mjs', 'bridge/attachments.mts', 'bridge/trash.mjs',
  'bridge/workflow-presets.mjs', 'bridge/resources/rag.md', 'bridge/resources/personal.md', 'bridge/personal.mjs', 'desktop/browser-policy.cts', 'desktop/browser.cjs', 'desktop/browser-sessions.cjs', 'desktop/browser-annotations.cts', 'desktop/browser-page-preload.cjs', 'desktop/context-menu.cts',
  'desktop/main.cjs', 'desktop/main-profile.cjs', 'desktop/main-backend.cjs', 'desktop/main-quit.cjs', 'desktop/app-updates.cjs', 'desktop/wayland-ime.cts', 'desktop/session-windows.cjs', 'desktop/window-ipc.cts', 'desktop/media-policy.cts', 'desktop/preferences.cjs', 'desktop/preload.cjs', 'desktop/files.cjs', 'desktop/editors.cts',
  'desktop/terminal.cjs', 'desktop/open-thread.cjs', 'desktop/tray.cts', 'desktop/quick-entry.cjs', 'desktop/theme.cts', 'desktop/copy-keys.cts', 'desktop/quick-entry-preload.cjs', 'desktop/quick-entry.html', 'desktop/screenshot-popup.cjs', 'desktop/screenshot-popup-preload.cjs', 'desktop/screenshot-popup.html',
  'desktop/runtime.mjs', 'desktop/state.cts', 'desktop/elpis-icon.png', 'desktop/love-spot-icon.png', 'desktop/love-spot-icon.svg', 'lib/agent-runs.mts', 'lib/service-tier.mts', 'lib/chat-worktree.ts', 'lib/turn-replacement.ts', 'lib/thread-deletion.ts', 'lib/approvals.ts', 'bridge/love-spot-store.cjs', 'bridge/love-spot-order.cts', 'bridge/love-spot-painting.cjs', 'bridge/matilda-face.cjs', 'bridge/matilda-clothes.cts', 'bridge/matilda-board-faces.cts', 'bridge/love-spot-talk.mjs', 'bridge/speech-buffer.mjs', 'bridge/love-agents.mjs', 'bridge/acp-nodes.mjs', 'bridge/workflow-acp.mjs', 'bridge/workflow-models.mts', 'bridge/workflow-worktrees.mjs', 'lib/love-spot.ts',
  'bridge/memory-budget.mjs', 'scripts/mem-meter.py',
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
# Started from the dock, the app lacks the shell's proxy; GNOME's proxy addresses (set by the VPN app) stand in, in the
# form a terminal exports, so the app and a terminal \`elpis\` share one bridge. The VPN app often leaves GNOME's mode at
# "none" while its proxy runs, so a listening proxy counts too (2 Nov: OpenRouter refused the direct route, so the RAG
# model menus were empty).
if [[ -z "\${HTTPS_PROXY:-}\${HTTP_PROXY:-}\${ALL_PROXY:-}\${https_proxy:-}\${http_proxy:-}\${all_proxy:-}" ]] && command -v gsettings >/dev/null; then
  manual=0; if [[ "$(gsettings get org.gnome.system.proxy mode 2>/dev/null)" == "'manual'" ]]; then manual=1; fi
  gnome_proxy() { local host port; host="$(gsettings get "org.gnome.system.proxy.$1" host 2>/dev/null | tr -d "'")"; port="$(gsettings get "org.gnome.system.proxy.$1" port 2>/dev/null)"; [[ -n "$host" && "\${port:-0}" != 0 ]] || return 1; (( manual )) || timeout 1 bash -c "exec 3<>/dev/tcp/$host/$port" 2>/dev/null || return 1; printf '%s://%s:%s/' "$2" "$host" "$port"; }
  web="$(gnome_proxy https http || gnome_proxy http http || true)"; socks="$(gnome_proxy socks socks || true)"
  [[ -n "$web" ]] && export HTTP_PROXY="$web" HTTPS_PROXY="$web" http_proxy="$web" https_proxy="$web"
  [[ -n "$socks" ]] && export ALL_PROXY="$socks" all_proxy="$socks"
  ignore="$(gsettings get org.gnome.system.proxy ignore-hosts 2>/dev/null | tr -d "[]' " || true)"
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

function requireFile(file: string) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) throw new Error(`Source symbolic link is not allowed: ${file}`);
  if (!stat.isFile()) throw new Error(`Expected a regular file: ${file}`);
  return stat;
}

function sha256(file: string) {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, 'r');
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(descriptor); }
  return hash.digest('hex');
}

function inputFile(file: string, destination: string): PackageFile {
  const stat = requireFile(file);
  return { source: file, path: destination, bytes: stat.size, mode: stat.mode & 0o777, sha256: sha256(file) };
}

function inputTree(directory: string, destination: string, keep: (path: string) => boolean = () => true): PackageFile[] {
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
function tryLink(source: string, output: string) {
  try { fs.linkSync(source, output); return true; } catch (error) {
    if (['EXDEV', 'EPERM', 'EMLINK', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code as string)) return false;
    throw error;
  }
}

// Resolve existing parent symlinks before checking whether a new destination overlaps an input.
function resolveDestination(file: string) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error(`Destination already exists: ${file}`);
  const suffix: string[] = [];
  let parent = file;
  while (!fs.existsSync(parent)) { suffix.unshift(path.basename(parent)); parent = path.dirname(parent); }
  return path.join(fs.realpathSync(parent), ...suffix);
}

/** Copy a built renderer and the exact desktop runtime closure. Never builds, installs pointers, or starts the app.
 * `outDirectory` is the renderer to ship (default: the source's out/, or one GitHub Actions built). With `linkRuntime`,
 * Electron's files are hard-linked from `electronDist` (an earlier installation's runtime) rather than copied, so an
 * installation adds about 30 MB instead of 310 MB; installations are never changed after staging. */
export function stageDesktop({ source = fileURLToPath(new URL('../', import.meta.url)), destination, electronDist, wsDirectory, ptyDirectory, rruleDirectory, outDirectory, linkRuntime = false }: Options = {}) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) throw new Error('An absolute destination is required');
  const target = resolveDestination(path.resolve(destination));
  source = fs.realpathSync(source);
  const electron = fs.realpathSync(electronDist || path.join(source, 'node_modules/electron/dist'));
  const ws = fs.realpathSync(wsDirectory || path.join(source, 'node_modules/ws'));
  const pty = fs.realpathSync(ptyDirectory || path.join(source, 'node_modules/node-pty'));
  const rrule = fs.realpathSync(rruleDirectory || path.join(source, 'node_modules/rrule'));
  const out = fs.realpathSync(outDirectory || path.join(source, 'out'));
  for (const input of [source, electron, ws, pty, rrule, out]) {
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
  const rruleIdentity = JSON.parse(fs.readFileSync(path.join(rrule, 'package.json'), 'utf8'));
  for (const name of ['LICENCE', 'dist/es5/rrule.js']) requireFile(path.join(rrule, name));
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
    // Automations' calendar rules (bridge/schedule-rules.mjs): rrule's self-contained build, its manifest and licence.
    ...['package.json', 'LICENCE', 'dist/es5/rrule.js'].map(name => inputFile(path.join(rrule, name), `app/node_modules/rrule/${name}`)),
  ];
  let commit = identity.commit || null;
  try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Repackaging preserves the installed identity. */ }
  const packageIdentity = { name: identity.name, productName: identity.productName || 'Elpis', desktopName: identity.desktopName, version: identity.version, commit,
    private: true, type: 'module', main: 'desktop/main.cjs', dependencies: { ws: wsIdentity.version, 'node-pty': ptyIdentity.version, rrule: rruleIdentity.version } };
  const generated = [
    { path: 'app/package.json', data: `${JSON.stringify(packageIdentity, null, 2)}\n`, mode: 0o644 },
    { path: 'launch', data: launcher, mode: 0o755 },
  ];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target); // Exclusive creation: never overwrite another installation.
  for (const file of files) {
    const output = path.join(target, file.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (!(linkRuntime && file.path.startsWith('runtime/') && tryLink(file.source!, output))) {
      fs.copyFileSync(file.source!, output, fs.constants.COPYFILE_EXCL);
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
  } catch (error) { process.stderr.write(`${(error as Error).message}\n`); process.exitCode = 1; }
}
