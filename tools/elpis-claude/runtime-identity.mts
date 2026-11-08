import { engineBin, exists, usable } from './runtime-process.mts';
import type { Runtime, CodeIdentity, BridgeState } from './runtime-types.mts';
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
export const here = path.dirname(fileURLToPath(import.meta.url));
// ---- launcher helper -----------------------------------------------------------------------------
export const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
// The environment the bridge inherits from the terminal that started it and that changes what it
// does: network proxy, the Claude and Antigravity programs and adapters, stores and auth homes.
// Request, working-directory, terminal and log-path variables are incidental and not listed.
export const PROXY_ENV_NAMES = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];
export const ENV_NAMES = [
    ...PROXY_ENV_NAMES,
    "NODE_USE_ENV_PROXY", "NODE_EXTRA_CA_CERTS",
    "CLAUDE_CODE_EXECUTABLE", "CLAUDE_CONFIG_DIR", "ELPIS_CLAUDE_PRUNE", "ELPIS_CLAUDE_USAGE_URL",
    "ELPIS_NO_AGY", "AGY_BIN", "AGY_DEFAULT_MODEL", "ACP_ADAPTER", "ACP_BRIDGE_STORE", "ACP_BRIDGE_NO_AGENTS", "ELPIS_AGENT_TOOLS",
    "CODEX_HOME", "CODEX_AUTH_HOME",
];
// The proxy bypass list as a set, without the loopback hosts the desktop launcher adds: a
// terminal and the app with the same proxy then share one bridge. Empty means unset.
export const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
export const bypassList = (value: string) => value.split(",").map((host) => host.trim()).filter((host) => host && !LOOPBACK.has(host)).sort().join(",") || undefined;
// Salted hashes of the set variables, so a state file never holds a proxy URL or a key.
export function environmentDigest(env: NodeJS.ProcessEnv, salt: string) {
    const digest: Record<string, string> = {};
    for (const name of ENV_NAMES) {
        const value = env[name] !== undefined && /^no_proxy$/i.test(name) ? bypassList(env[name] as string) : env[name];
        if (value !== undefined)
            digest[name] = sha(`${salt}\0${name}\0${value}`);
    }
    return digest;
}
// The names whose value differs between a running bridge's record and this launch.
export function differingNames(recorded: BridgeState | null, env: NodeJS.ProcessEnv) {
    if (!recorded?.envSalt || !recorded.env)
        return ENV_NAMES.filter((name) => env[name] !== undefined);
    const now = environmentDigest(env, recorded.envSalt);
    return ENV_NAMES.filter((name) => now[name] !== (recorded.env as Record<string, string>)[name]);
}
// What must match between the running bridge and a new launch besides the environment: the bridge's
// own code and packages, the engine, and the node that runs it.
export function codeIdentity(bridgeScript: string, node = process.execPath) {
    const script = fs.realpathSync(bridgeScript);
    const dir = path.dirname(script);
    const files: Record<string, string> = {};
    for (const name of fs.readdirSync(dir).filter((n) => (n.endsWith(".mjs") || n.endsWith(".mts")) || n === "package.json" || n === "package-lock.json").sort())
        files[name] = sha(fs.readFileSync(path.join(dir, name)));
    let modules = null;
    try {
        const adapter = JSON.parse(fs.readFileSync(path.join(dir, "node_modules/@agentclientprotocol/claude-agent-acp/package.json"), "utf8"));
        modules = { path: fs.realpathSync(path.join(dir, "node_modules")), adapter: adapter.version };
    }
    catch { }
    const bin = engineBin();
    let engine;
    try {
        const real = fs.realpathSync(bin);
        const st = fs.statSync(real);
        engine = { path: real, id: st.size <= 1 << 20 ? sha(fs.readFileSync(real)) : `${st.size}:${st.mtimeMs}` };
    }
    catch (e) {
        throw new Error(`engine binary ${bin} is not usable: ${(e as Error).message}`);
    }
    let runtime;
    try {
        const real = fs.realpathSync(node);
        const st = fs.statSync(real);
        runtime = { path: real, version: node === process.execPath ? process.version : null, id: `${st.size}:${st.mtimeMs}` };
    }
    catch (e) {
        throw new Error(`node ${node} is not usable: ${(e as Error).message}`);
    }
    // The script's own path too: its helpers (adapters, MCP server) load from beside it for as long as the bridge lives.
    return { hash: sha(JSON.stringify({ script, files, modules, engine, runtime })).slice(0, 16), script, engine: engine.path };
}
// "tui-pointer-20261019-78ef58f2" for an installed bundle, the folder otherwise.
export const versionOf = (script: string | null | undefined) => /\/versions\/([^/]+)\//.exec(script ?? "")?.[1] ?? path.dirname(script ?? "");
export function readJson<T>(file: string): T | null { try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
catch {
    return null;
} }
// A standard installed package records the exact engine paired with its provider tools.
export async function installedEngine(bundle: string) {
    const manifestFile = path.join(bundle, "package/codex-package.json");
    if (!exists(manifestFile))
        return null; // Legacy/development layouts keep their configured engine.
    const manifest = readJson<{
        layoutVersion?: number;
        variant?: string;
        entrypoint?: string;
    }>(manifestFile), source = readJson<{
        source_head?: string;
        runtime_sha256: string;
    }>(path.join(bundle, "source.json"));
    if (manifest?.layoutVersion !== 1 || manifest.variant !== "elpis" || manifest.entrypoint !== "bin/codex"
        || !/^[a-f0-9]{40}$/i.test(source?.source_head ?? "") || !/^[a-f0-9]{64}$/i.test(source?.runtime_sha256 ?? "")) {
        throw new Error("The installed engine package has no valid source/pair receipt.");
    }
    const engine = path.join(bundle, "package/bin/codex");
    if (!usable(engine) || fs.realpathSync(engine) !== engine || !fs.statSync(engine).isFile())
        throw new Error("The installed engine package has no usable paired executable.");
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(engine))
        hash.update(chunk);
    if (hash.digest("hex") !== (source as {
        runtime_sha256: string;
    }).runtime_sha256.toLowerCase())
        throw new Error("The installed engine does not match its source receipt checksum.");
    return engine;
}
export function writeDirectSuccessor(rt: Runtime, script: string) {
    const tmp = `${rt.successorDirect}.${process.pid}.${randomBytes(8).toString("hex")}`;
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
        fs.writeFileSync(fd, script);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, rt.successorDirect);
}
export function isDirectSuccessor(rt: Runtime, script: string) {
    let fd;
    try {
        fd = fs.openSync(rt.successorDirect, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return false;
        throw new Error("The direct handover marker is invalid.");
    }
    try {
        const st = fs.fstatSync(fd);
        if (!st.isFile() || st.uid !== (process.getuid as () => number)() || (st.mode & 0o077) || st.size > 4096 || fs.readFileSync(fd, "utf8").trim() !== script) {
            throw new Error("The direct handover marker is invalid.");
        }
        return true;
    }
    finally {
        fs.closeSync(fd);
    }
}
export async function managedSuccessorPair(state: BridgeState, identity: CodeIdentity) {
    try {
        const previous = fs.realpathSync(state.engine), next = fs.realpathSync(identity.engine);
        const oldBundle = path.resolve(path.dirname(previous), "../.."), newBundle = path.resolve(path.dirname(next), "../..");
        return path.dirname(oldBundle) === path.dirname(newBundle)
            && fs.realpathSync(path.dirname(state.script)) === fs.realpathSync(path.join(oldBundle, "tools/elpis-claude"))
            && fs.realpathSync(path.dirname(identity.script)) === fs.realpathSync(path.join(newBundle, "tools/elpis-claude"))
            && await installedEngine(oldBundle) === previous && await installedEngine(newBundle) === next;
    }
    catch {
        return false;
    }
}
export async function selectSuccessorEngine(rt: Runtime, bridgeScript: string) {
    let successor;
    try {
        successor = fs.realpathSync(fs.readFileSync(rt.successor, "utf8").trim());
    }
    catch {
        return;
    }
    if (successor !== fs.realpathSync(bridgeScript) || fs.realpathSync(path.dirname(bridgeScript)) !== fs.realpathSync(here))
        return;
    const bundle = path.resolve(here, "../..");
    if (!exists(path.join(bundle, "package/codex-package.json")))
        return;
    if (process.env.ELPIS_ENGINE_BIN) {
        let inherited;
        try {
            inherited = fs.realpathSync(process.env.ELPIS_ENGINE_BIN);
        }
        catch {
            return;
        }
        const previous = path.resolve(path.dirname(inherited), "../..");
        // An explicit custom engine outside these managed versions remains a deliberate choice.
        if (path.dirname(previous) !== path.dirname(bundle) || await installedEngine(previous) !== inherited)
            return;
    }
    // Old deployed bridges spawn this helper with their own engine still in the environment.
    process.env.ELPIS_ENGINE_BIN = await installedEngine(bundle) as string;
    if (isDirectSuccessor(rt, successor))
        for (const name of PROXY_ENV_NAMES)
            delete process.env[name];
}
