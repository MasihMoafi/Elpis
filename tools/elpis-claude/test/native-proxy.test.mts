import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import test from "node:test";
import { connectAppServer } from "../app-server-connection.mts";
import { Engine } from "../acp-engine-transport.mts";
import { spawnPrivate, startSharedEngine, shutdownRuntime } from "../runtime-transport.mts";
import { createTestTempDir, removeTestTempDir } from "./temp-root.mts";

// Assert what each actual subprocess inherits, including lowercase settings and the
// Node proxy switch. The provider bridge's environment must remain available to Mother.
const proxy = {
    HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", ALL_PROXY: "socks5://127.0.0.1:9",
    http_proxy: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9", all_proxy: "socks5://127.0.0.1:9",
    NO_PROXY: "localhost,127.0.0.1,::1", no_proxy: "localhost,127.0.0.1,::1", NODE_USE_ENV_PROXY: "1",
};

test("Codex subprocesses bypass the proxy while Mother's provider environment is preserved", { timeout: 15000 }, async t => {
    const root = createTestTempDir(path.join(os.tmpdir(), "native-proxy-"));
    const executable = path.join(root, "engine.mts"), trace = path.join(root, "env.jsonl");
    fs.writeFileSync(executable, `#!${process.execPath}
import fs from "node:fs";
const names = ${JSON.stringify([...Object.keys(proxy), "NATIVE_PROXY_TRACE"])};
const env = Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
fs.appendFileSync(process.env.NATIVE_PROXY_TRACE, JSON.stringify({ pid: process.pid, env }) + "\\n");
await import(${JSON.stringify(new URL("./fake-app-server.mts", import.meta.url).href)});
`, { mode: 0o755 });
    const values = { ...proxy, ELPIS_ENGINE_BIN: executable, ELPIS_BRIDGE_SOCKET: path.join(root, "bridge.sock"), NATIVE_PROXY_TRACE: trace };
    const before = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
    Object.assign(process.env, values);
    t.after(async () => {
        await shutdownRuntime();
        for (const [name, value] of Object.entries(before)) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        removeTestTempDir(root);
    });
    const direct = async (pid?: number) => {
        let record: { pid: number; env: NodeJS.ProcessEnv } | undefined;
        const deadline = Date.now() + 3000;
        while (!record && Date.now() < deadline) {
            const records: { pid: number; env: NodeJS.ProcessEnv }[] = fs.existsSync(trace)
                ? fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
            record = pid ? records.find(entry => entry.pid === pid) : records.at(-1);
            if (!record) await pause(20);
        }
        assert.ok(record, "the engine recorded its startup environment");
        for (const name of Object.keys(proxy)) {
            assert.equal(record.env[name], undefined, `${name} must not reach Codex`);
            assert.equal(process.env[name], proxy[name as keyof typeof proxy], `${name} remains available to Mother`);
        }
        assert.equal(record.env.NATIVE_PROXY_TRACE, trace, "unrelated environment reaches the engine");
    };
    await t.test("shared chat engine", async () => {
        const entry = await startSharedEngine().promise;
        try { await direct(entry?.child?.pid); } finally { await shutdownRuntime(); }
    });
    await t.test("private helper engine", async () => {
        const child = spawnPrivate();
        try { await direct(child.pid); } finally { const exited = once(child, "exit"); child.kill(); await exited; }
    });
    await t.test("standalone app-server connection", async () => {
        fs.writeFileSync(trace, "");
        const conn = connectAppServer({ engineBin: executable });
        try { await conn.ready; await direct(); } finally { conn.close(); }
    });
    await t.test("ACP fallback without a shared bridge", async () => {
        const engine = new Engine(executable, null);
        try {
            await engine.call("initialize", { clientInfo: { name: "proxy-test", title: null, version: "1" }, capabilities: {} });
            await direct(engine.child?.pid);
        } finally { await engine.stop(); }
    });
});
