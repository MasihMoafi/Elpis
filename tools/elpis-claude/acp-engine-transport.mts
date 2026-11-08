import type { EngineMessage, EngineResponses } from './acp-engine-protocol.mts';
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RequestError } from "@agentclientprotocol/sdk";
import { redactSecrets } from "./log-redaction.mts";
import { runtimeDir } from "./shared-runtime.mts";
import WebSocket from "ws";
export function bridgeEndpoint() {
    const explicit = process.env.ELPIS_APP_BRIDGE_SOCKET || process.env.ELPIS_BRIDGE_SOCKET;
    const url = process.env.ELPIS_BRIDGE_URL;
    if (!explicit && url && !url.startsWith("unix://"))
        return url;
    const socket = (explicit || url || runtimeDir().sock).replace(/^unix:\/\//, "");
    let stat;
    try {
        stat = fs.lstatSync(socket);
    }
    catch (error) {
        if (!explicit && !url && (error as NodeJS.ErrnoException).code === "ENOENT")
            return null;
        throw error;
    }
    if (!path.isAbsolute(socket) || !stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
        throw new Error("The Elpis bridge socket must be private and owned by the current user");
    }
    return `ws+unix://${socket}:/`;
}
// The shared bridge's JSON-RPC connection, or one private stdio app-server.
export class Engine {
    declare pending: Map<string | number, {
        resolve: (value: unknown) => void;
        reject: (error: unknown) => void;
    }>;
    declare seq: number;
    declare tail: string;
    declare dead: RequestError | null;
    declare stopping: boolean;
    declare onMessage: (msg: EngineMessage) => void;
    declare resolveExit: (error: RequestError) => void;
    declare exited: Promise<RequestError>;
    declare opened: Promise<void>;
    declare socket: WebSocket | undefined;
    declare child: ChildProcessWithoutNullStreams | undefined;
    constructor(bin: string, endpoint: string | null) {
        this.pending = new Map();
        this.seq = 0;
        this.tail = "";
        this.dead = null;
        this.stopping = false;
        this.onMessage = () => { };
        this.exited = new Promise<RequestError>(resolve => { this.resolveExit = resolve; });
        if (endpoint) {
            const socket = this.socket = new WebSocket(endpoint, { maxPayload: 8 * 1024 * 1024 });
            this.opened = new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => { socket.terminate(); reject(new Error("Elpis bridge connection timed out")); }, 10000);
                socket.once("open", () => { clearTimeout(timer); resolve(); });
                socket.once("error", error => { clearTimeout(timer); reject(error); });
                socket.once("close", () => { clearTimeout(timer); reject(new Error("Elpis bridge connection closed")); });
            });
            this.socket.on("message", raw => {
                let msg;
                try {
                    msg = JSON.parse(raw.toString());
                }
                catch {
                    return;
                }
                this.receive(msg);
            });
            this.socket.on("close", () => this.end("connection closed"));
            return;
        }
        this.opened = Promise.resolve();
        this.child = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
        this.child.stdin.on("error", () => { });
        this.child.stderr.on("data", (d) => { this.tail = (this.tail + d).slice(-2000); });
        let buffer = "";
        this.child.stdout.on("data", (chunk) => {
            buffer += chunk;
            let i;
            while ((i = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, i).trim();
                buffer = buffer.slice(i + 1);
                if (!line)
                    continue;
                let msg;
                try {
                    msg = JSON.parse(line);
                }
                catch {
                    continue;
                }
                this.receive(msg);
            }
        });
        this.child.once("error", (e) => this.end(`could not start (${e.message}). Is Elpis installed at ${bin}?`));
        // 'close' comes after the last output was read, so an answer already written is not lost.
        this.child.once("close", (code, signal) => this.end(`exited (${signal ?? code})`));
    }
    receive(msg: EngineMessage) {
        if (msg.id !== undefined && !msg.method) {
            const p = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (p)
                msg.error ? p.reject(new RequestError(-32603, msg.error.message ?? "The Elpis engine refused the request")) : p.resolve(msg.result);
        }
        else
            this.onMessage(msg);
    }
    end(why: string) {
        if (this.dead)
            return;
        const tail = redactSecrets(this.tail.trim()).slice(-500);
        this.dead = new RequestError(-32603, `The Elpis engine ${why}${tail ? `: ${tail}` : ""}`);
        for (const p of this.pending.values())
            p.reject(this.dead);
        this.pending.clear();
        this.resolveExit(this.dead);
    }
    write(msg: object) {
        if (this.dead)
            return;
        if (this.socket)
            this.socket.send(JSON.stringify(msg));
        else
            (this.child as ChildProcessWithoutNullStreams).stdin.write(`${JSON.stringify(msg)}\n`);
    }
    call<K extends keyof EngineResponses>(method: K, params: object): Promise<EngineResponses[K]>;
    call<T = unknown>(method: string, params: object): Promise<T>;
    call<T>(method: string, params: object): Promise<T> {
        if (this.dead)
            return Promise.reject(this.dead);
        return new Promise<T>((resolve, reject) => {
            const id = `acp-${++this.seq}`;
            this.pending.set(id, { resolve: value => resolve(value as T), reject });
            this.write({ id, method, params });
        });
    }
    notify(method: string, params: object) { this.write({ method, params }); }
    respond(id: string | number, result: object) { this.write({ id, result }); }
    refuse(id: string | number, message: string) { this.write({ id, error: { code: -32601, message } }); }
    async stop() {
        this.stopping = true;
        if (this.socket) {
            this.socket.close();
            await this.exited;
            return;
        }
        const child = this.child as ChildProcessWithoutNullStreams;
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGTERM"), 1000);
        const hard = setTimeout(() => child.kill("SIGKILL"), 4000);
        await this.exited;
        clearTimeout(timer);
        clearTimeout(hard);
    }
}
