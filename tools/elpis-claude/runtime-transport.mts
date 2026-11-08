import { homeDir, engineBin, note, pause, exists, isSocket, startToken, alive, terminate, usable } from './runtime-process.mts';
import type { SocketProbe, Listener, EngineInfo, PrivateChild, EngineEntry, ProxyInput } from './runtime-types.mts';
import { WebSocketServer, WebSocket } from "ws";
import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { redactedLines } from "./log-redaction.mts";
export const shared = () => Boolean(process.env.ELPIS_SHARED_BRIDGE);
// A unix socket path must fit sockaddr_un (108 bytes, with the terminator).
export const SOCKET_PATH_MAX = 100;
// ---- sockets ------------------------------------------------------------------------------------
// { ok: true } when something accepts connections at the path, else the connect error's code.
export function probe(sock: string, timeoutMs = 1000) {
    return new Promise<SocketProbe>((resolve) => {
        const socket = net.connect(sock);
        const done = (result: SocketProbe) => { socket.destroy(); resolve(result); };
        socket.setTimeout(timeoutMs, () => done({ ok: false, code: "ETIMEDOUT" }));
        socket.once("connect", () => done({ ok: true }));
        socket.once("error", (e) => done({ ok: false, code: (e as NodeJS.ErrnoException).code ?? String(e) }));
    });
}
// Removes a socket file nothing listens on. Never touches a living socket or a non-socket.
export async function removeStaleSocket(sock: string) {
    if (!exists(sock))
        return;
    if (!isSocket(sock))
        throw new Error(`${sock} exists and is not a socket; refusing to remove it`);
    const r = await probe(sock);
    if (r.ok)
        throw new Error(`${sock} is served by a living process; refusing to remove it`);
    if (r.code !== "ECONNREFUSED" && r.code !== "ENOENT")
        throw new Error(`cannot tell whether ${sock} is stale (${r.code})`);
    fs.rmSync(sock, { force: true });
}
// ---- private runtime directory --------------------------------------------------------------------
export function ensurePrivateDir(dir: string) {
    try {
        fs.mkdirSync(dir, { mode: 0o700 });
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST")
            throw e;
    }
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory())
        throw new Error(`${dir} must be a real directory`);
    if (st.uid !== (process.getuid as () => number)())
        throw new Error(`${dir} is owned by another user`);
    if (st.mode & 0o077)
        fs.chmodSync(dir, 0o700);
}
// One directory per ELPIS_HOME under a uid-only base. The path is hashed so its length is fixed.
export function runtimeDir(home = homeDir()) {
    let real = path.resolve(home);
    try {
        real = fs.realpathSync.native(real);
    }
    catch { }
    const key = createHash("sha256").update(real).digest("hex").slice(0, 16);
    const bases = [
        process.env.XDG_RUNTIME_DIR && path.join(process.env.XDG_RUNTIME_DIR, "elpis-bridge"),
        path.join(os.tmpdir(), `elpis-bridge-${(process.getuid as () => number)()}`),
    ].filter((base): base is string => Boolean(base));
    for (const base of bases) {
        const dir = path.join(base, key);
        const sock = path.join(dir, "bridge.sock");
        if (Buffer.byteLength(sock) > SOCKET_PATH_MAX)
            continue;
        ensurePrivateDir(base);
        ensurePrivateDir(dir);
        return { home: real, dir, sock, state: path.join(dir, "state.json"), lock: path.join(dir, "launch.lock"), log: path.join(dir, "daemon.log"), successor: path.join(dir, "successor"), successorDirect: path.join(dir, "successor-direct") };
    }
    throw new Error(`no runtime directory with a socket path under ${SOCKET_PATH_MAX} bytes (set XDG_RUNTIME_DIR or TMPDIR to a shorter path)`);
}
// ---- the bridge's listener ------------------------------------------------------------------------
// The published listener: its socket is identified by device and inode, so that a socket (or state
// file) a later bridge publishes at the same path is never mistaken for this one's.
export let listener: Listener | null = null;
// { server, sock, id, stopped, closed }
export let stopped = false;
// a listener was stopped: no engine starts until the next createBridgeServer
export function createBridgeServer() {
    stopped = false;
    if (!shared())
        return new WebSocketServer({ host: "127.0.0.1", port: Number(process.env.PORT ?? 47820) });
    const sock = process.env.ELPIS_BRIDGE_SOCKET;
    if (!sock || !path.isAbsolute(sock))
        throw new Error("ELPIS_SHARED_BRIDGE needs an absolute ELPIS_BRIDGE_SOCKET");
    const server = http.createServer((req, res) => { res.statusCode = 426; res.end("WebSocket upgrade required\n"); });
    const entry: Listener = listener = { server, sock, id: null, stopped: false, closed: null };
    // An upgrade that was accepted just before the listener stopped is refused too.
    const wss = new WebSocketServer({ server, verifyClient: () => !entry.stopped });
    // After the caller has attached its handlers; a failure surfaces as the server's 'error'.
    setImmediate(() => {
        if (entry.stopped)
            return;
        removeStaleSocket(sock).then(() => {
            if (entry.stopped)
                return;
            server.listen(sock, () => {
                if (entry.stopped) {
                    try {
                        if (fs.lstatSync(sock).isSocket())
                            fs.rmSync(sock, { force: true });
                    }
                    catch { }
                    return;
                } // stopped while binding
                fs.chmodSync(sock, 0o600);
                const st = fs.lstatSync(sock);
                entry.id = `${st.dev}:${st.ino}`;
            });
        }, (e) => wss.emit("error", e));
    });
    return wss;
}
// Synchronous and idempotent: stops accepting, then removes this bridge's own socket and state, and
// nothing a later bridge published. Returns when the server has closed.
export function stopBridgeListener() {
    const entry = listener;
    if (!entry)
        return Promise.resolve();
    if (entry.stopped)
        return entry.closed;
    entry.stopped = true;
    stopped = true;
    const sock = entry.sock;
    const stateFile = path.join(path.dirname(sock), "state.json");
    try {
        if (JSON.parse(fs.readFileSync(stateFile, "utf8")).pid === process.pid)
            fs.rmSync(stateFile, { force: true });
    }
    catch { }
    // Closing a server unlinks whatever is at its path. If another bridge's socket has replaced ours,
    // it is moved aside for the instant that takes.
    let aside = null;
    try {
        const st = fs.lstatSync(sock);
        if (st.isSocket() && entry.id === `${st.dev}:${st.ino}`)
            fs.rmSync(sock, { force: true });
        else if (st.isSocket() && entry.id !== null) {
            aside = `${sock}.aside-${process.pid}`;
            fs.renameSync(sock, aside);
        }
    }
    catch {
        aside = null;
    }
    entry.closed = new Promise<void>((resolve) => {
        try {
            entry.server.close(() => resolve());
        }
        catch {
            resolve();
        }
        entry.server.closeIdleConnections?.();
        setTimeout(resolve, 2000).unref();
    });
    if (aside) {
        try {
            if (fs.existsSync(sock))
                fs.rmSync(aside, { force: true });
            else
                fs.renameSync(aside, sock);
        }
        catch { }
    }
    return entry.closed;
}
// A bridge handing over gave up its listener but still serves the chats working in it, so its connections reach the
// engine again.
export function allowEngines() { stopped = false; }
// A bridge handing over to a newer one (acp-bridge.mts startDrain) serves that bridge here, for the chats still
// running in it; drain.json names this socket and those chats.
export const drainFile = () => path.join(path.dirname(process.env.ELPIS_BRIDGE_SOCKET as string), "drain.json");
export function createDrainServer() {
    const sock = path.join(path.dirname(process.env.ELPIS_BRIDGE_SOCKET as string), `drain-${process.pid}.sock`);
    const server = http.createServer((req, res) => { res.statusCode = 426; res.end("WebSocket upgrade required\n"); });
    const wss = new WebSocketServer({ server });
    fs.rmSync(sock, { force: true });
    const listening = new Promise((resolve, reject) => { server.once("error", reject); server.listen(sock, () => { fs.chmodSync(sock, 0o600); resolve(sock); }); });
    return { wss, sock, listening, close: () => { try {
            server.close();
        }
        catch { } fs.rmSync(sock, { force: true }); } };
}
export function bridgeUrl(wss: WebSocketServer) {
    const address = wss.address();
    if (typeof address === "string")
        return `ws+unix://${address}:/`;
    if (!address && shared())
        return `ws+unix://${process.env.ELPIS_BRIDGE_SOCKET}:/`;
    return `ws://127.0.0.1:${(address as {
        port: number;
    }).port}`;
}
// ---- engines --------------------------------------------------------------------------------------
export const privateEngines = new Set<PrivateChild>();
// ChildProcess spawned by this bridge
export const proxies = new Set<EngineProxy>();
export let sharedEngine: EngineEntry | null = null;
// { promise, child, dir, sock }
// An engine never outlives its bridge. On Linux the kernel sends it SIGTERM when the bridge dies, even by SIGKILL
// from the memory guard (setpriv --pdeathsig execs the engine in place, so its pid and command line stay the engine's).
export const setpriv = process.platform === "linux" ? ["/usr/bin/setpriv", "/bin/setpriv"].find(usable) : undefined;
export const spawnEngine = (args: string[], options: SpawnOptions) => setpriv
    ? spawn(setpriv, ["--pdeathsig", "TERM", "--", engineBin(), ...args], options)
    : spawn(engineBin(), args, options);
export function spawnPrivate() {
    const child = spawnEngine(["app-server"], { stdio: ["pipe", "pipe", "ignore"] }) as PrivateChild;
    privateEngines.add(child);
    child.once("exit", () => privateEngines.delete(child));
    return child;
}
// The native engine's own socket, in an `engine-*` directory only this bridge writes to; engine.json
// lets the launcher find (and stop) an engine whose bridge died.
export function startSharedEngine() {
    const entry: EngineEntry = { promise: null, child: null, dir: null, sock: null };
    sharedEngine = entry;
    entry.promise = (async () => {
        const parent = process.env.ELPIS_BRIDGE_SOCKET ? path.dirname(process.env.ELPIS_BRIDGE_SOCKET) : null;
        if (!parent)
            throw new Error("ELPIS_SHARED_BRIDGE needs ELPIS_BRIDGE_SOCKET");
        ensurePrivateDir(parent);
        const dir = entry.dir = fs.mkdtempSync(path.join(parent, "engine-"));
        const sock = entry.sock = path.join(dir, "e.sock");
        let tail = "";
        const child = entry.child = spawnEngine(["app-server", "--listen", `unix://${sock}`], { stdio: ["ignore", "ignore", "pipe"] });
        redactedLines(child.stderr as Readable, clean => { tail = (tail + clean + "\n").slice(-4000); note(`engine: ${clean}`); });
        const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(`exited (${signal ?? code})`)));
        child.once("exit", () => {
            note(`native engine ${child.pid} exited`);
            if (sharedEngine === entry)
                sharedEngine = null;
            for (const p of [...proxies])
                p.engineGone();
            cleanEngineDir(entry.dir);
        });
        const failed = new Promise((resolve) => child.once("error", (e) => resolve(`failed to start: ${e.message}`)));
        fs.writeFileSync(path.join(dir, "engine.json"), JSON.stringify({ pid: child.pid, token: startToken(child.pid as number), bridgePid: process.pid, bridgeToken: startToken(process.pid) }), { mode: 0o600 });
        const deadline = Date.now() + 30000;
        for (;;) {
            const stop = await Promise.race([exited, failed, pause(50).then(() => null)]);
            if (stop)
                throw new Error(`native engine ${stop} before it listened${tail ? `: ${tail.trim()}` : ""}`);
            if ((await probe(sock)).ok)
                return entry;
            if (Date.now() > deadline) {
                await terminate(child);
                throw new Error("native engine did not listen within 30 s");
            }
        }
    })();
    entry.promise.catch(() => { if (sharedEngine === entry)
        sharedEngine = null; cleanEngineDir(entry.dir); });
    return entry;
}
// Removes an engine directory made by a bridge, and, if the engine left its socket target behind in
// the native socket directory (the symlink points there), that dead socket. Only a real directory
// of this user named `engine-*` is removed, and only socket files of this user are touched.
export function cleanEngineDir(dir: string | null) {
    if (!dir || !path.basename(dir).startsWith("engine-"))
        return;
    try {
        const st = fs.lstatSync(dir);
        if (!st.isDirectory() || st.uid !== (process.getuid as () => number)())
            return;
    }
    catch {
        return;
    }
    try {
        const link = path.join(dir, "e.sock");
        const st = fs.lstatSync(link);
        if (st.isSymbolicLink()) {
            const target = fs.readlinkSync(link);
            const owned = (() => { try {
                const t = fs.lstatSync(target);
                return t.isSocket() && t.uid === (process.getuid as () => number)();
            }
            catch {
                return false;
            } })();
            if (owned && path.basename(path.dirname(target)).startsWith("codex-daemon-"))
                probe(target).then((r) => { if (!r.ok)
                    fs.rmSync(target, { force: true }); });
        }
    }
    catch { }
    fs.rmSync(dir, { recursive: true, force: true });
}
// Whether `pid` is the engine this directory's record describes: same start token and, where the
// kernel shows command lines, an `app-server` listening on this directory's socket.
export function isEngineOf(info: EngineInfo | null, dir: string): info is EngineInfo {
    if (!info || !alive(info.pid, info.token))
        return false;
    if (!fs.existsSync("/proc/self/stat"))
        return true; // no command lines to read: the start token stands
    try {
        const argv = fs.readFileSync(`/proc/${info.pid}/cmdline`, "utf8").split("\0");
        return argv.includes("app-server") && argv.includes(`unix://${path.join(dir, "e.sock")}`);
    }
    catch {
        return false;
    }
}
// What the bridge sees of an engine in shared mode. The first frame decides: `initialize` from the
// delegate tool gets a private engine, everything else the shared one. Same surface as a child, plus
// the guarantee a pipe lacks: when the engine or its connection ends unexpectedly, every request
// that was queued or already sent and not answered gets one JSON-RPC error answer, then `exit`.
export class EngineProxy {
    declare stdin: ProxyInput;
    declare stdout: EventEmitter;
    declare mode: "private" | "shared" | null;
    declare pid: number | undefined;
    declare pending: string[];
    declare inflight: Map<string, unknown>;
    declare scan: string;
    declare socket: WebSocket | null;
    declare child: PrivateChild | null;
    declare gone: boolean;
    declare closing: boolean;
    constructor() {
        this.stdin = new EventEmitter() as ProxyInput;
        this.stdout = new EventEmitter();
        this.stdin.write = (chunk) => { this.#write(String(chunk)); return true; };
        this.stdin.end = () => { };
        this.mode = null;
        this.pid = undefined;
        this.pending = []; // frames before the connection opens
        this.inflight = new Map<string, unknown>(); // JSON id -> id of requests written and not yet answered
        this.scan = ""; // a private engine's stdout, for answers (the bridge still gets every chunk as it came)
        this.socket = null;
        this.child = null;
        this.gone = false;
        this.closing = false;
        proxies.add(this);
    }
    #error(id: unknown, why: string) { this.stdout.emit("data", `${JSON.stringify({ id, error: { code: -32603, message: why } })}\n`); }
    #answered(text: string) {
        for (const line of text.split("\n")) {
            if (!line.includes('"id"'))
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (msg?.id !== undefined && !msg.method)
                this.inflight.delete(JSON.stringify(msg.id));
        }
    }
    #fail(why: string) {
        const unanswered = [...this.inflight.values()];
        this.inflight.clear();
        for (const frame of this.pending.splice(0)) {
            try {
                if (JSON.parse(frame).id === undefined)
                    note(`dropped ${JSON.parse(frame).method ?? "a message"}: ${why}`);
            }
            catch { }
        }
        for (const id of unanswered)
            this.#error(id, why);
        if (this.stdin.listenerCount("error"))
            this.stdin.emit("error", new Error(why));
        else
            note(why);
    }
    #write(text: string) {
        for (const frame of text.split("\n")) {
            if (!frame)
                continue;
            let msg = null;
            try {
                msg = JSON.parse(frame);
            }
            catch { }
            if (this.gone || (!this.mode && stopped)) {
                const why = this.gone ? "the engine connection is closed" : "the bridge is shutting down";
                if (!this.gone)
                    this.#end(why);
                if (msg?.id !== undefined && msg.method)
                    this.#error(msg.id, why);
                else
                    note(`dropped ${msg?.method ?? "a message"}: ${why}`);
                continue;
            }
            if (!this.mode)
                this.#choose(frame, msg);
            if (msg?.id !== undefined && msg.method)
                this.inflight.set(JSON.stringify(msg.id), msg.id);
            this.#send(frame);
        }
    }
    #choose(first: string, msg: {
        method?: string;
        params?: {
            clientInfo?: {
                name?: string;
            };
        };
    } | null) {
        const helper = msg?.method === "initialize" && msg.params?.clientInfo?.name === "elpis-agents";
        this.mode = helper ? "private" : "shared";
        if (helper) {
            const child = this.child = spawnPrivate();
            this.pid = child.pid;
            child.stdout.on("data", (d) => { this.scan = (this.scan + d.toString("latin1")).slice(-1 << 20); const cut = this.scan.lastIndexOf("\n"); if (cut >= 0) {
                this.#answered(this.scan.slice(0, cut));
                this.scan = this.scan.slice(cut + 1);
            } this.stdout.emit("data", d); });
            child.stdin.on("error", (e) => (this.stdin.listenerCount("error") ? this.stdin.emit("error", e) : note(`engine input: ${e.message}`)));
            // After its output has been read, so an answer already in the pipe is not replaced by an error.
            child.once("close", (code, signal) => this.#end(`the helper's engine exited (${signal ?? code})`));
            return;
        }
        this.#connect(false);
    }
    // A client can arrive between the shared engine's death and the bridge seeing it exit; its socket
    // then never opens. It waits for that engine to exit and joins a fresh one, once (2 Nov: about one
    // run in four of shared-provider-sessions refused a client right after the engine was killed).
    #connect(retried: boolean) {
        const entry = sharedEngine ?? startSharedEngine();
        const ready = entry.promise as Promise<EngineEntry>;
        ready.then((engine) => {
            if (this.gone)
                return;
            this.pid = (engine.child as ChildProcess).pid;
            let opened = false;
            const socket = this.socket = new WebSocket(`ws+unix://${engine.sock}:/`);
            socket.on("open", () => { opened = true; for (const frame of this.pending.splice(0))
                socket.send(frame); });
            socket.on("message", (data) => { const text = String(data); this.#answered(text); this.stdout.emit("data", `${text}\n`); });
            socket.on("error", (e) => note(`engine connection: ${e.message}`));
            // 'close' follows the last message, so nothing the engine answered is rejected.
            socket.on("close", () => {
                if (opened || retried || this.gone || this.closing)
                    return this.#end("the native engine connection closed");
                const child = engine.child as ChildProcess;
                const ended = child.exitCode !== null || child.signalCode !== null
                    ? Promise.resolve(true)
                    : Promise.race([new Promise((r) => child.once("exit", () => r(true))), pause(2000).then(() => false)]);
                ended.then((dead) => {
                    if (this.gone)
                        return;
                    if (!dead)
                        return this.#end("the native engine connection closed");
                    if (sharedEngine === entry)
                        sharedEngine = null;
                    note("joining a fresh engine: the shared one exited before this client connected");
                    this.socket = null;
                    this.#connect(true);
                });
            });
        }, (e) => this.#end(e.message));
    }
    #send(frame: string) {
        if (this.child) {
            this.child.stdin.write(`${frame}\n`);
            return;
        }
        if (this.socket?.readyState === WebSocket.OPEN)
            this.socket.send(frame);
        else
            this.pending.push(frame);
    }
    #end(why: string) {
        if (this.gone)
            return;
        this.gone = true;
        proxies.delete(this);
        if (this.closing) {
            this.pending.length = 0;
            this.inflight.clear();
        }
        else
            this.#fail(why);
        this.stdout.emit("exit", why);
    }
    // The shared engine's process ended. Its connection reports it after the last message arrived.
    engineGone() {
        if (this.mode !== "shared" || this.gone)
            return;
        if (this.socket)
            setTimeout(() => (this.socket as WebSocket).terminate(), 1000).unref();
        else
            this.#end("the shared native engine exited");
    }
    // Closes this connection only. A helper's private engine is stopped.
    kill() {
        this.closing = true;
        if (this.child) {
            this.child.kill();
            return;
        }
        this.socket?.close();
        this.#end("closed");
    }
}
export function createEngine() {
    return shared() ? new EngineProxy() : spawnPrivate();
}
// Stops the engines this bridge started, and removes what it created (not the launcher's files of
// other bridges). Unpublishing comes first, so a launcher arriving now starts a new bridge instead
// of joining this one. The caller exits afterwards.
export async function shutdownRuntime() {
    const closed = stopBridgeListener();
    for (const p of [...proxies])
        p.kill();
    const stopping = [...privateEngines].map((child) => terminate(child));
    const entry = sharedEngine;
    if (entry) {
        sharedEngine = null;
        stopping.push((entry.promise as Promise<EngineEntry>).then(() => terminate(entry.child as ChildProcess), () => entry.child && terminate(entry.child)).then(() => cleanEngineDir(entry.dir)));
    }
    await Promise.all([closed, ...stopping]);
}
