import type { Owner } from './workflow-types.mts';
import fs from "node:fs";
export const writeAtomic = (file: string, data: string) => { fs.writeFileSync(`${file}.tmp`, data, { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); };
export const readJson = <T,>(file: string): T | null => { try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}
catch {
    return null;
} };
export function startTokenOf(pid: number) {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    catch {
        return null;
    }
}
export function ownerAlive(owner: Owner | null | undefined) {
    if (!owner?.pid)
        return false;
    try {
        process.kill(owner.pid, 0);
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EPERM")
            return false;
    }
    return owner.token == null || startTokenOf(owner.pid) === owner.token;
}
