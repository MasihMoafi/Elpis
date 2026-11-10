import { productionFiles } from "./package-files.mts";
export { productionFiles } from "./package-files.mts";
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
          (!path.posix.extname(target) || /\.(?:[cm]?js|json|node)$|\.so(?:\.\d+)*$|\/LICEN[CS]E[^/]*$/.test(target)),
      ),
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {})) visit(dependency, directory);
  };
  for (const name of ["zod", "proper-lockfile"]) visit(name, source);
  // Custom character portraits (bridge/character-image.mts) decode through sharp: its loader, and the native addon and
  // libvips built for this machine, which npm installs as optional per-platform packages (10 Nov: without them the
  // packaged app could not open).
  visit("sharp", source);
  const sharp = path.dirname(createRequire(path.join(source, "package.json")).resolve("sharp/package.json"));
  for (const name of [`@img/sharp-${process.platform}-${process.arch}`, `@img/sharp-libvips-${process.platform}-${process.arch}`]) visit(name, sharp);
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
