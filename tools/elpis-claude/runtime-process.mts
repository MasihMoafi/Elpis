import { spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs";
import { redactSecrets } from "./log-redaction.mts";
export const homeDir = () => process.env.ELPIS_HOME || `${process.env.HOME}/.elpis-next`;
export const engineBin = () => process.env.ELPIS_ENGINE_BIN ?? `${process.env.HOME}/.local/bin/elpis`;
export const note = (s: string) => process.stderr.write(`[shared-runtime] ${redactSecrets(s)}\n`);
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const exists = (p: string) => { try {
    fs.lstatSync(p);
    return true;
}
catch {
    return false;
} };
export const isSocket = (p: string) => { try {
    return fs.lstatSync(p).isSocket();
}
catch {
    return false;
} };
// ---- processes: a pid alone can be reused, so a start token goes with it ------------------------
// Linux: field 22 of /proc/<pid>/stat (clock ticks since boot); elsewhere ps's start time.
export function startToken(pid: number) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    catch { }
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}
export function alive(pid: number, token?: string | null) {
    if (!Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM")
            return false;
    }
    return token == null || startToken(pid) === token;
}
export async function terminate(child: ChildProcess, ms = 5000) {
    if (child.exitCode !== null || child.signalCode !== null)
        return;
    const gone = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    if (await Promise.race([gone, pause(ms).then(() => false)]) === false) {
        child.kill("SIGKILL");
        await Promise.race([gone, pause(2000)]);
    }
}
export async function terminatePid(pid: number, token?: string | null, ms = 5000) {
    if (!alive(pid, token))
        return;
    try {
        process.kill(pid, "SIGTERM");
    }
    catch { }
    for (let waited = 0; waited < ms && alive(pid, token); waited += 50)
        await pause(50);
    if (alive(pid, token)) {
        try {
            process.kill(pid, "SIGKILL");
        }
        catch { }
        for (let i = 0; i < 40 && alive(pid, token); i++)
            await pause(50);
    }
}
export function usable(file: string) { try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
}
catch {
    return false;
} }
