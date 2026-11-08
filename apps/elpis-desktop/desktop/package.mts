import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

type PackageFile = { source?: string; path: string; bytes: number; mode: number; sha256: string; generated?: boolean };
type Options = {
  source?: string | undefined;
  destination?: string | undefined;
  electronDist?: string | undefined;
  wsDirectory?: string | undefined;
  ptyDirectory?: string | undefined;
  rruleDirectory?: string | undefined;
  outDirectory?: string | undefined;
  linkRuntime?: boolean | undefined;
};

/** Every file the packaged app loads besides the renderer; package.test.mjs checks it against their imports. */
export const productionFiles = [
  "bridge/matilda-companion.mts",
  "desktop/app-menu.cts",
  "lib/app-menu-commands.cts",
  "lib/preference-choices.cts",
  "bridge/voice.mts",
  "bridge/voice-handoff.cts",
  "bridge/kokoro.mts",
  "bridge/read-aloud-provider.mts",
  "lib/speech-model.mts",
  "bridge/schedule.mts",
  "bridge/schedule-rules.mts",
  "bridge/schedule-mcp.mts",
  "bridge/kokoro-worker.py",
  "bridge/resources/permission-policy.mts",
  "bridge/resources/app-server-connection.mts",
  "bridge/resources/bridge-wire.mts",
  "bridge/resources/workflow-concurrency.mts",
  "bridge/import-chats.mts",
  "bridge/settings-files.mts",
  "bridge/app-identity.mts",
  "desktop/sleep-blocker.cts",
  "bridge/session-context.mts",
  "bridge/side-turn.mts",
  "bridge/thread-titles.mts",
  "bridge/token-accounting.mts",
  "bridge/profile-env.mts",
  "bridge/projection-values.mts",
  "lib/love-spot-audio.mts",
  "lib/audio-path.mts",
  "bridge/love-interview.mts",
  "bridge/agent-output.mts",
  "bridge/improve.mts",
  "bridge/integration-projections.mts",
  "bridge/improve-source.mts",
  "bridge/improve-check.mts",
  "desktop/improve.cts",
  "bridge/browser-mcp.mts",
  "bridge/claude-mcp-import.mts",
  "desktop/browser-agent.cts",
  "desktop/browser-identity.cts",
  "desktop/documents.cts",
  "desktop/main-error-guard.cts",
  "desktop/output-errors.cts",
  "desktop/screen-capture.cts",
  "bridge/canvas-plan.mts",
  "bridge/experiment-lab.mts",
  "bridge/client.mts",
  "bridge/cloudroom-auth.mts",
  "bridge/cloudroom-contract.mts",
  "bridge/cloudroom-transfers.mts",
  "bridge/subscription-models.mts",
  "bridge/cloudroom-vm.mts",
  "bridge/permission-presets.mts",
  "bridge/customize.mts",
  "bridge/skill-trash.mts",
  "bridge/github-connector.mts",
  "bridge/elpis-features.mts",
  "bridge/smart-prune.mts",
  "bridge/files.mts",
  "bridge/folders.mts",
  "bridge/git.mts",
  "bridge/recorded-changes.mts",
  "bridge/provider-keys.mts",
  "bridge/provider-settings.mts",
  "bridge/provider-models.mts",
  "bridge/provider-projections.mts",
  "bridge/client-state.mts",
  "bridge/client-paths.mts",
  "bridge/client-permissions.mts",
  "bridge/client-protocol.mts",
  "bridge/client-archive-history.mts",
  "bridge/client-connection.mts",
  "bridge/client-thread-decorate.mts",
  "bridge/client-thread-read.mts",
  "bridge/client-side-chat.mts",
  "bridge/client-customize.mts",
  "bridge/client-script-runs.mts",
  "bridge/client-thread-list.mts",
  "bridge/client-thread-actions.mts",
  "bridge/client-models.mts",
  "bridge/client-settings.mts",
  "bridge/client-voice.mts",
  "bridge/client-wire.mts",
  "bridge/client-mcp.mts",
  "bridge/client-context.mts",
  "bridge/client-workflows.mts",
  "bridge/client-rewind.mts",
  "bridge/client-rollout-cache.mts",
  "bridge/client-rpc.mts",
  "bridge/client-turns.mts",
  "bridge/client-changes.mts",
  "bridge/client-mutation.mts",
  "bridge/client-approvals.mts",
  "bridge/rag-command.mts",
  "bridge/rewind-history.mts",
  "bridge/message-versions.mts",
  "bridge/rewind-snapshots.mts",
  "bridge/bounded-cache.mts",
  "bridge/rollout-lines.mts",
  "bridge/rollout-readers.mts",
  "bridge/spawn-links.mts",
  "bridge/session-creators.mts",
  "bridge/app-catalogs.mts",
  "bridge/customize-page.mts",
  "bridge/validate.mts",
  "bridge/server.mts",
  "bridge/server-http.mts",
  "bridge/server-love-spot.mts",
  "bridge/server-voice.mts",
  "bridge/server-files.mts",
  "bridge/server-settings.mts",
  "bridge/server-workflows.mts",
  "bridge/server-threads.mts",
  "bridge/trajectory-projection.mts",
  "bridge/dev-servers.mts",
  "bridge/tools.mts",
  "bridge/runtime-paths.mts",
  "bridge/transcription.mts",
  "bridge/attachments.mts",
  "bridge/trash.mts",
  "bridge/workflow-presets.mts",
  "bridge/resources/rag.md",
  "bridge/resources/personal.md",
  "bridge/personal.mts",
  "desktop/browser-policy.cts",
  "desktop/browser.cts",
  "desktop/browser-sessions.cts",
  "desktop/browser-annotations.cts",
  "desktop/browser-page-preload.cts",
  "desktop/context-menu.cts",
  "desktop/main.cts",
  "desktop/main-profile.cts",
  "desktop/main-backend.cts",
  "desktop/main-quit.cts",
  "desktop/app-updates.cts",
  "desktop/wayland-ime.cts",
  "desktop/session-windows.cts",
  "desktop/window-ipc.cts",
  "desktop/media-policy.cts",
  "desktop/preferences.cts",
  "desktop/preload.cts",
  "desktop/files.cts",
  "desktop/editors.cts",
  "desktop/terminal.cts",
  "desktop/open-thread.cts",
  "desktop/tray.cts",
  "desktop/preload-path.cts",
  "desktop/quick-entry.cts",
  "desktop/theme.cts",
  "desktop/copy-keys.cts",
  "desktop/quick-entry-preload.cts",
  "desktop/quick-entry.html",
  "desktop/screenshot-popup.cts",
  "desktop/screenshot-popup-preload.cts",
  "desktop/screenshot-popup.html",
  "desktop/runtime.mts",
  "desktop/state.cts",
  "desktop/elpis-icon.png",
  "desktop/love-spot-icon.png",
  "desktop/love-spot-icon.svg",
  "lib/agent-runs.mts",
  "lib/service-tier.mts",
  "lib/chat-worktree.ts",
  "lib/turn-replacement.ts",
  "lib/thread-deletion.ts",
  "lib/approvals.ts",
  "bridge/love-spot-store.cts",
  "bridge/love-spot-talk-prompt.mts",
  "bridge/love-spot-order.cts",
  "bridge/love-spot-painting.cts",
  "bridge/love-spot-speech.mts",
  "bridge/matilda-face.cts",
  "bridge/matilda-clothes.cts",
  "bridge/matilda-board-faces.cts",
  "bridge/love-spot-talk.mts",
  "bridge/love-spot-watcher.cts",
  "bridge/speech-buffer.mts",
  "bridge/speech-chunks.mts",
  "bridge/love-agents.mts",
  "bridge/acp-nodes.mts",
  "bridge/workflow-acp.mts",
  "bridge/workflow-acp/create-execution.mts",
  "bridge/workflow-acp/create-mother-turns.mts",
  "bridge/workflow-acp/create-node-routing.mts",
  "bridge/workflow-acp/create-replanning.mts",
  "bridge/workflow-acp/create-review.mts",
  "bridge/workflow-acp/create-run-api.mts",
  "bridge/workflow-acp/create-run-outputs.mts",
  "bridge/workflow-acp/create-run-progress.mts",
  "bridge/workflow-acp/create-run-storage.mts",
  "bridge/workflow-acp/create-supervision.mts",
  "bridge/workflow-acp/format.mts",
  "bridge/workflow-acp/history.mts",
  "bridge/workflow-acp/limits.mts",
  "bridge/workflow-acp/mother-runtime.mts",
  "bridge/workflow-acp/locks.mts",
  "bridge/workflow-acp/status.mts",
  "bridge/workflow-acp/types.mts",
  "bridge/workflow-acp/validation.mts",
  "bridge/workflow-models.mts",
  "bridge/workflow-worktrees.mts",
  "lib/love-spot.ts",
  "bridge/memory-budget.mts",
  "scripts/mem-meter.py",
  // Mother agent: the complete router closure, prompt assets and MIT notice.
  "bridge/router/LICENSE-dsh-superagent",
  "bridge/router/admission.mts",
  "bridge/router/app.mts",
  "bridge/router/app/api.mts",
  "bridge/router/app/assessment.mts",
  "bridge/router/app/cache.mts",
  "bridge/router/app/cards.mts",
  "bridge/router/app/context.mts",
  "bridge/router/app/elpis-migration.mts",
  "bridge/router/app/host.mts",
  "bridge/router/app/http.mts",
  "bridge/router/app/legacy-settings.mts",
  "bridge/router/app/legacy-sources.mts",
  "bridge/router/app/legacy-tickets.mts",
  "bridge/router/app/legacy-values.mts",
  "bridge/router/app/links.mts",
  "bridge/router/app/migration.mts",
  "bridge/router/app/notices.mts",
  "bridge/router/app/passes.mts",
  "bridge/router/app/prompts.mts",
  "bridge/router/app/resource-names.mts",
  "bridge/router/app/resources.mts",
  "bridge/router/app/retry-health.mts",
  "bridge/router/app/settings-history.mts",
  "bridge/router/app/settings.mts",
  "bridge/router/app/setup.mts",
  "bridge/router/app/skill-files.mts",
  "bridge/router/app/store-read.mts",
  "bridge/router/app/store.mts",
  "bridge/router/app/tools/executor.mts",
  "bridge/router/app/tools/main.mts",
  "bridge/router/app/tools/tool.mts",
  "bridge/router/app/versions.mts",
  "bridge/router/app/views/overview.mts",
  "bridge/router/app/views/records.mts",
  "bridge/router/app/views/settings.mts",
  "bridge/router/app/views/sources.mts",
  "bridge/router/app/views/text.mts",
  "bridge/router/app/views/threads.mts",
  "bridge/router/app/views/tickets.mts",
  "bridge/router/core/assignments.mts",
  "bridge/router/core/engine.mts",
  "bridge/router/core/errors.mts",
  "bridge/router/core/evals.mts",
  "bridge/router/core/ids.mts",
  "bridge/router/core/index.mts",
  "bridge/router/core/intake.mts",
  "bridge/router/core/memory.mts",
  "bridge/router/core/model.mts",
  "bridge/router/core/part.mts",
  "bridge/router/core/ports.mts",
  "bridge/router/core/reasons.mts",
  "bridge/router/core/replies.mts",
  "bridge/router/core/stage.mts",
  "bridge/router/core/tickets.mts",
  "bridge/router/deployment.mts",
  "bridge/router/executor/adapters.mts",
  "bridge/router/executor/background.mts",
  "bridge/router/executor/discovery.mts",
  "bridge/router/executor/dsh.mts",
  "bridge/router/executor/effects.mts",
  "bridge/router/executor/execution-environment.mts",
  "bridge/router/executor/index.mts",
  "bridge/router/executor/messages.mts",
  "bridge/router/executor/role-models.mts",
  "bridge/router/executor/runtime-background.mts",
  "bridge/router/executor/runtime.mts",
  "bridge/router/executor/service.mts",
  "bridge/router/executor/sessions.mts",
  "bridge/router/executor/settings.mts",
  "bridge/router/executor/settlement.mts",
  "bridge/router/executor/store.mts",
  "bridge/router/executor/tool-runtime.mts",
  "bridge/router/executor/tool-stdio.mts",
  "bridge/router/executor/transient.mts",
  "bridge/router/executor/worker-retries.mts",
  "bridge/router/executor/worker-slots.mts",
  "bridge/router/executor/workspace.mts",
  "bridge/router/infra/commands.mts",
  "bridge/router/infra/environment.mts",
  "bridge/router/infra/git-environment.mts",
  "bridge/router/infra/github-env.mts",
  "bridge/router/infra/health-contract.mts",
  "bridge/router/infra/health.mts",
  "bridge/router/infra/paths.mts",
  "bridge/router/infra/setup.mts",
  "bridge/router/infra/store.mts",
  "bridge/router/infra/text.mts",
  "bridge/router/infra/types.mts",
  "bridge/router/limits.mts",
  "bridge/router/model.mts",
  "bridge/router/mother-agent.mts",
  "bridge/router/outbox.mts",
  "bridge/router/policy.mts",
  "bridge/router/prompts/admission.md",
  "bridge/router/prompts/cli.md",
  "bridge/router/prompts/dispatch.md",
  "bridge/router/prompts/handoff-orchestrator.md",
  "bridge/router/prompts/handoff-worker.md",
  "bridge/router/prompts/handoff.md",
  "bridge/router/prompts/orchestrator.md",
  "bridge/router/prompts/replies.md",
  "bridge/router/prompts/shared.md",
  "bridge/router/prompts/subscriptions.md",
  "bridge/router/prompts/team/communication.md",
  "bridge/router/prompts/team/delivery.md",
  "bridge/router/prompts/team/scope.md",
  "bridge/router/prompts/work.md",
  "bridge/router/prompts/worker.md",
  "bridge/router/settings.mts",
  "bridge/router/skills/mother-elpis-chat/SKILL.md",
  "bridge/router/skills/mother-github/SKILL.md",
  "bridge/router/source-context.mts",
  "bridge/router/sources/admission-context.mts",
  "bridge/router/sources/elpis-chat-channel.mts",
  "bridge/router/sources/elpis-chat-history.mts",
  "bridge/router/sources/elpis-chat-read.mts",
  "bridge/router/sources/elpis-chat-transport.mts",
  "bridge/router/sources/elpis-chat.mts",
  "bridge/router/sources/github-channel.mts",
  "bridge/router/sources/github-kind.mts",
  "bridge/router/sources/github-poll-state.mts",
  "bridge/router/sources/github-pull.mts",
  "bridge/router/sources/github-read.mts",
  "bridge/router/sources/github-repository.mts",
  "bridge/router/sources/github-trigger.mts",
  "bridge/router/sources/github.mts",
  "bridge/router/sources/host.mts",
  "bridge/router/sources/kind.mts",
  "bridge/router/sources/kv.mts",
  "bridge/router/sources/poll.mts",
  "bridge/router/sources/registry.mts",
  "bridge/router/sources/settings.mts",
  "bridge/router/subprocess.mts",
  "bridge/router/worktree-name.mts",
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
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  try {
    let bytes;
    while ((bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function inputFile(file: string, destination: string): PackageFile {
  const stat = requireFile(file);
  return { source: file, path: destination, bytes: stat.size, mode: stat.mode & 0o777, sha256: sha256(file) };
}

function inputTree(
  directory: string,
  destination: string,
  keep: (path: string) => boolean = () => true,
): PackageFile[] {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`Source symbolic link is not allowed: ${directory}`);
  if (!stat.isDirectory()) throw new Error(`Expected a directory: ${directory}`);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => {
      const source = path.join(directory, entry.name);
      const target = path.posix.join(destination, entry.name);
      if (!keep(target)) return [];
      return entry.isDirectory() ? inputTree(source, target, keep) : [inputFile(source, target)];
    });
}

/** Router validation and locking run in Node, outside the renderer bundle. Include their production dependencies. */
function routerDependencies(source: string) {
  const files: PackageFile[] = [],
    versions: Record<string, string> = {};
  const visit = (name: string, from: string) => {
    const require = createRequire(path.join(from, "package.json"));
    const directory = path.dirname(require.resolve(`${name}/package.json`));
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")) as {
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    };
    if (versions[name]) {
      if (versions[name] !== manifest.version) throw new Error(`Conflicting runtime dependency: ${name}`);
      return;
    }
    versions[name] = manifest.version;
    files.push(
      ...inputTree(
        directory,
        `app/node_modules/${name}`,
        target =>
          !/(?:^|\/)(?:tests?|examples?)(?:\/|$)|\.test\./.test(target) &&
          (!path.posix.extname(target) || /\.(?:[cm]?js|json)$|\/LICEN[CS]E[^/]*$/.test(target)),
      ),
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, directory);
  };
  for (const name of ["zod", "proper-lockfile"]) visit(name, source);
  return { files, versions };
}

/** Hard-links `source` to `output`; false when the filesystem refuses (another device, no permission). */
function tryLink(source: string, output: string) {
  try {
    fs.linkSync(source, output);
    return true;
  } catch (error) {
    if (["EXDEV", "EPERM", "EMLINK", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code as string)) return false;
    throw error;
  }
}

// Resolve existing parent symlinks before checking whether a new destination overlaps an input.
function resolveDestination(file: string) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error(`Destination already exists: ${file}`);
  const suffix: string[] = [];
  let parent = file;
  while (!fs.existsSync(parent)) {
    suffix.unshift(path.basename(parent));
    parent = path.dirname(parent);
  }
  return path.join(fs.realpathSync(parent), ...suffix);
}

/** Copy a built renderer and the exact desktop runtime closure. Never builds, installs pointers, or starts the app.
 * `outDirectory` is the renderer to ship (default: the source's out/, or one GitHub Actions built). With `linkRuntime`,
 * Electron's files are hard-linked from `electronDist` (an earlier installation's runtime) rather than copied, so an
 * installation adds about 30 MB instead of 310 MB; installations are never changed after staging. */
export function stageDesktop({
  source = fileURLToPath(new URL("../", import.meta.url)),
  destination,
  electronDist,
  wsDirectory,
  ptyDirectory,
  rruleDirectory,
  outDirectory,
  linkRuntime = false,
}: Options = {}) {
  if (typeof destination !== "string" || !path.isAbsolute(destination))
    throw new Error("An absolute destination is required");
  const target = resolveDestination(path.resolve(destination));
  source = fs.realpathSync(source);
  const electron = fs.realpathSync(electronDist || path.join(source, "node_modules/electron/dist"));
  const ws = fs.realpathSync(wsDirectory || path.join(source, "node_modules/ws"));
  const pty = fs.realpathSync(ptyDirectory || path.join(source, "node_modules/node-pty"));
  const rrule = fs.realpathSync(rruleDirectory || path.join(source, "node_modules/rrule"));
  const out = fs.realpathSync(outDirectory || path.join(source, "out"));
  for (const input of [source, electron, ws, pty, rrule, out]) {
    const relative = path.relative(input, target);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      throw new Error(`Destination is inside a package input: ${input}`);
    }
  }
  requireFile(path.join(out, "index.html"));
  const executable = requireFile(path.join(electron, "electron"));
  if (!(executable.mode & 0o111)) throw new Error("Electron executable is not executable");
  for (const name of ["LICENSE", "LICENSES.chromium.html"]) requireFile(path.join(electron, name));
  requireFile(path.join(ws, "LICENSE"));
  requireFile(path.join(source, "package.json"));
  requireFile(path.join(ws, "package.json"));
  const identity = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  const wsIdentity = JSON.parse(fs.readFileSync(path.join(ws, "package.json"), "utf8"));
  const ptyIdentity = JSON.parse(fs.readFileSync(path.join(pty, "package.json"), "utf8"));
  if (ptyIdentity.name !== "node-pty" || typeof ptyIdentity.version !== "string")
    throw new Error("node-pty package identity is invalid");
  for (const name of ["LICENSE", "lib/index.js", "build/Release/pty.node"]) requireFile(path.join(pty, name));
  const rruleIdentity = JSON.parse(fs.readFileSync(path.join(rrule, "package.json"), "utf8"));
  for (const name of ["LICENCE", "dist/es5/rrule.js"]) requireFile(path.join(rrule, name));
  if (
    typeof identity.name !== "string" ||
    typeof identity.version !== "string" ||
    wsIdentity.name !== "ws" ||
    typeof wsIdentity.version !== "string"
  ) {
    throw new Error("Desktop or ws package identity is invalid");
  }
  const router = routerDependencies(source);
  const files = [
    ...productionFiles.map(name => inputFile(path.join(source, name), `app/${name}`)),
    ...inputTree(out, "app/out"),
    ...inputTree(electron, "runtime/electron"),
    ...inputTree(ws, "app/node_modules/ws"),
    ...router.files,
    // The integrated terminal (desktop/terminal.cjs): node-pty's loader, licence and its build for this Electron.
    ...["package.json", "LICENSE", "build/Release/pty.node"].map(name =>
      inputFile(path.join(pty, name), `app/node_modules/node-pty/${name}`),
    ),
    ...inputTree(path.join(pty, "lib"), "app/node_modules/node-pty/lib", name => !/\.test\.js$|\.map$/.test(name)),
    // Automations' calendar rules (bridge/schedule-rules.mjs): rrule's self-contained build, its manifest and licence.
    ...["package.json", "LICENCE", "dist/es5/rrule.js"].map(name =>
      inputFile(path.join(rrule, name), `app/node_modules/rrule/${name}`),
    ),
  ];
  let commit = identity.commit || null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* Repackaging preserves the installed identity. */
  }
  const packageIdentity = {
    name: identity.name,
    productName: identity.productName || "Elpis",
    desktopName: identity.desktopName,
    version: identity.version,
    commit,
    private: true,
    type: "module",
    main: "desktop/main.cts",
    dependencies: {
      ws: wsIdentity.version,
      "node-pty": ptyIdentity.version,
      rrule: rruleIdentity.version,
      ...router.versions,
    },
  };
  const generated = [
    { path: "app/package.json", data: `${JSON.stringify(packageIdentity, null, 2)}\n`, mode: 0o644 },
    { path: "launch", data: launcher, mode: 0o755 },
  ];
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(target); // Exclusive creation: never overwrite another installation.
  for (const file of files) {
    const output = path.join(target, file.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    if (!(linkRuntime && file.path.startsWith("runtime/") && tryLink(file.source!, output))) {
      fs.copyFileSync(file.source!, output, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(output, file.mode);
    }
    if (sha256(output) !== file.sha256) throw new Error(`Source changed while packaging: ${file.source}`);
  }
  for (const file of generated) {
    const output = path.join(target, file.path);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, file.data, { flag: "wx", mode: file.mode });
    files.push({
      path: file.path,
      generated: true,
      bytes: Buffer.byteLength(file.data),
      mode: file.mode,
      sha256: sha256(output),
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  // The manifest names files by their place in the installation only: where they were built from on this machine
  // (the user's folders) never travels with a copy of the app.
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    entryPoint: "launch",
    fileCount: files.length,
    payloadBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files: files.map(({ source: _source, ...file }) => file),
    externalRequirements: [
      "Node.js selected by ELPIS_NODE_BIN, PATH or /usr/local/node/bin/node",
      "Installed Elpis engine and provider bridge",
      "Optional configured command-line tools",
    ],
  };
  const manifestPath = path.join(target, "manifest.json");
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  return {
    destination: target,
    launcher: path.join(target, "launch"),
    manifest: manifestPath,
    fileCount: files.length + 1,
    payloadBytes: manifest.payloadBytes,
    totalBytes: manifest.payloadBytes + fs.statSync(manifestPath).size,
    wsVersion: wsIdentity.version,
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const { values } = parseArgs({
      options: {
        destination: { type: "string" },
        source: { type: "string" },
        "electron-dist": { type: "string" },
        "ws-directory": { type: "string" },
        "pty-directory": { type: "string" },
        "out-directory": { type: "string" },
        "link-runtime": { type: "boolean" },
      },
    });
    const result = stageDesktop({
      source: values.source,
      destination: values.destination,
      electronDist: values["electron-dist"],
      wsDirectory: values["ws-directory"],
      ptyDirectory: values["pty-directory"],
      outDirectory: values["out-directory"],
      linkRuntime: values["link-runtime"],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
