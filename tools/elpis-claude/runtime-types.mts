import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { EventEmitter } from "node:events";
import http from "node:http";
export type SocketProbe = {
    ok: true;
} | {
    ok: false;
    code: string;
};
export type Runtime = {
    home: string;
    dir: string;
    sock: string;
    state: string;
    lock: string;
    log: string;
    successor: string;
    successorDirect: string;
};
export type Listener = {
    server: http.Server;
    sock: string;
    id: string | null;
    stopped: boolean;
    closed: Promise<void> | null;
};
export type EngineInfo = {
    pid: number;
    token?: string | null;
    bridgePid?: number;
    bridgeToken?: string | null;
};
export type CodeIdentity = {
    hash: string;
    script: string;
    engine: string;
};
export type BridgeState = {
    pid: number;
    token?: string | null;
    identity: string;
    envSalt?: string;
    env?: Record<string, string>;
    script: string;
    engine: string;
};
export type PrivateChild = ChildProcess & {
    stdin: Writable;
    stdout: Readable;
};
export type EngineEntry = {
    promise: Promise<EngineEntry> | null;
    child: ChildProcess | null;
    dir: string | null;
    sock: string | null;
};
export type ProxyInput = EventEmitter & {
    write: (chunk: string | Buffer) => boolean;
    end: () => void;
};
