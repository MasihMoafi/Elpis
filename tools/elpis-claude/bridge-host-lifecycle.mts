import type { BridgeClient, BridgeContext } from "./bridge-types.mts";
import { createBridgeServer, stopBridgeListener, shutdownRuntime, createDrainServer, drainFile, probe, startToken, allowEngines } from "./shared-runtime.mts";
import { closeWhenQuiet } from "./handover.mts";
import { WorkflowRunner } from "./workflow-runner.mts";
import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
export function createHostLifecycle({ HOME, wss, clients, contexts, helperConns, sendClient, storeChain, log, workflows, noticesDue }: {
    HOME: string;
    wss: ReturnType<typeof createBridgeServer>;
    clients: Set<BridgeClient>;
    contexts: Set<BridgeContext>;
    helperConns: WeakSet<BridgeClient>;
    sendClient(client: BridgeClient, message: object): void;
    storeChain(): Promise<void>;
    log(message: string): void;
    workflows(): Pick<WorkflowRunner, 'close' | 'release' | 'busy'>;
    noticesDue(): number;
}) {
    let idleTimer: NodeJS.Timeout | undefined, stopping = false;
    async function stopBridge(successor?: string) {
        if (stopping)
            return;
        stopping = true;
        clearTimeout(idleTimer);
        workflows().close(); // its runs stay running: the next runtime resumes them from their journals
        if (draining) {
            draining.server.close();
            try {
                if (JSON.parse(readFileSync(drainFile(), "utf8")).pid === process.pid)
                    rmSync(drainFile(), { force: true });
            }
            catch { }
        }
        stopBridgeListener();
        await storeChain();
        for (const c of contexts)
            c.close();
        await shutdownRuntime();
        // Started only now, so the new bridge never meets this one's engines or unsaved chats.
        if (successor)
            spawn(process.execPath, [join(dirname(successor), "shared-runtime.mts"), successor], { detached: true, stdio: ["ignore", "ignore", "inherit"], cwd: HOME }).unref();
        process.exit(0);
    }
    // A newer installation takes over while chats work (handover.mts): this bridge gives it bridge.sock at once and keeps
    // only the chats working now, which the newer bridge reaches through this drain socket until each is done.
    type DrainState = {
        threads: Set<string>;
        held: Set<string>;
        released: Set<string>;
        server: ReturnType<typeof createDrainServer>;
        exiting?: NodeJS.Timeout | null;
    };
    let draining: DrainState | null = null;
    function busyThreads() { const ids = new Set<string>(); for (const c of contexts)
        for (const id of c.busyThreads())
            ids.add(id); return ids; }
    // `threads` are the chats working now (released one by one); `held` are the idle chats this bridge's engines have
    // locked for writing. Both are served here until this bridge ends, so the newer engine never meets their lock.
    function writeDrain() {
        const file = drainFile();
        const active = draining as NonNullable<typeof draining>;
        writeFileSync(`${file}.tmp`, JSON.stringify({ pid: process.pid, token: startToken(process.pid), sock: active.server.sock, threads: [...new Set([...active.threads, ...active.held])] }), { mode: 0o600 });
        renameSync(`${file}.tmp`, file);
    }
    async function startDrain(successor: string) {
        if (stopping || draining)
            return;
        const launchSuccessor = () => spawn(process.execPath, [join(dirname(successor), "shared-runtime.mts"), successor], { detached: true, stdio: ["ignore", "ignore", "inherit"], cwd: HOME }).unref();
        workflows().release(); // the newer runtime resumes the runs from their journals
        if (![...contexts].some((c) => c.busy()))
            return void stopBridge(successor);
        const server = createDrainServer();
        server.wss.on("connection", (socket) => { const ws = socket as BridgeClient; ws.drainShadow = true; wss.emit("connection", ws); });
        const held = new Set((await Promise.all([...contexts].map((c) => c.loadedThreads()))).flat());
        draining = { threads: busyThreads(), held, released: new Set(), server };
        const started = Date.now();
        await server.listening;
        writeDrain();
        log(`handing over to ${successor} while ${draining.threads.size} chats work`);
        await stopBridgeListener();
        allowEngines();
        launchSuccessor();
        for (let i = 0; i < 300 && !(await probe(process.env.ELPIS_BRIDGE_SOCKET as string)).ok; i++)
            await new Promise((r) => setTimeout(r, 100));
        log(`the newer bridge answers after ${Date.now() - started} ms; moving the clients`);
        // The delegate tool's connections never reconnect: they stay until their chats are done.
        for (const ws of clients)
            if (!ws.drainShadow && !helperConns.has(ws))
                closeWhenQuiet(ws, "Session backend changed");
        checkDrain();
    }
    function checkDrain() {
        if (!draining || stopping)
            return;
        const now = busyThreads();
        // Work a remaining delegate connection started meanwhile stays here too.
        for (const id of now)
            if (!draining.released.has(id))
                draining.threads.add(id);
        let changed = false;
        for (const id of [...draining.threads]) {
            if (now.has(id))
                continue;
            draining.threads.delete(id);
            if (draining.held.has(id))
                continue; // its engine still locks it: it stays here until this bridge ends
            draining.released.add(id);
            changed = true;
            log(`handing over: chat ${id} is done here`);
            for (const ws of clients)
                if (ws.drainShadow)
                    sendClient(ws, { method: "bridge/released", params: { threadId: id } });
        }
        if (changed)
            writeDrain();
        // Its last events get a second to reach the newer bridge before this one exits.
        if (!draining.threads.size && ![...contexts].some((c) => c.busy()) && !draining.exiting) {
            draining.exiting = setTimeout(() => { (draining as DrainState).exiting = null; if (!(draining as DrainState).threads.size && ![...contexts].some((c) => c.busy()))
                void stopBridge();
            else
                checkDrain(); }, 1000);
        }
    }
    function checkIdle() {
        if (stopping)
            return;
        checkDrain();
        for (const c of [...contexts])
            c.releaseIfUnused();
        clearTimeout(idleTimer);
        // A running workflow, or a notice still due, keeps the runtime (WR3).
        const working = () => clients.size || [...contexts].some((c) => c.busy()) || workflows().busy() || noticesDue();
        if (!process.env.ELPIS_SHARED_BRIDGE || working())
            return;
        idleTimer = setTimeout(async () => {
            if (working())
                return;
            await stopBridge();
        }, 30000);
    }
    for (const signal of ["SIGTERM", "SIGINT"])
        process.once(signal, () => stopBridge());
    return { checkIdle, startDrain, clearIdle: () => clearTimeout(idleTimer), get stopping() { return stopping; }, get draining() { return !!draining; } };
}
