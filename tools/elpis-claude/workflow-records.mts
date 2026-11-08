import { writeAtomic, readJson } from './workflow-files.mts';
import type { Run, Cache } from './workflow-types.mts';
import fs from "node:fs";
import path from "node:path";
export function createRunRecords(home: string, now: () => number, log: (message: string) => void) {
    const runs = new Map<string, Run>();
    const saving = new Map<string, NodeJS.Timeout>();
    const runsDir = path.join(home, 'runs');
    fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
    // ---- runs -------------------------------------------------------------------------------------------
    function summary(run: Run) {
        const count = (s: string) => run.agents.filter((a) => a.state === s).length;
        return {
            id: run.id, name: run.name, status: run.status, parentThreadId: run.parentThreadId, origin: run.origin, cwd: run.cwd,
            scriptPath: run.scriptPath, resumedFrom: run.resumedFrom, createdAt: run.createdAt, updatedAt: run.updatedAt, endedAt: run.endedAt,
            agents: { total: run.agents.length, running: count("running") + count("retrying"), queued: count("queued"), done: count("done"), failed: count("failed"), skipped: count("skipped") },
            budget: run.budget, spent: run.spent, notice: run.notice?.state ?? null,
        };
    }
    function scan() {
        let names: string[] = [];
        try {
            names = fs.readdirSync(runsDir);
        }
        catch { }
        for (const name of names)
            if (!runs.has(name))
                load(name);
    }
    function load(id: string): Run | null {
        if (runs.has(id))
            return runs.get(id) as Run;
        if (!/^wf_[\w-]+$/.test(id))
            return null;
        const run = readJson<Run>(path.join(runsDir, id, "run.json"));
        if (!run)
            return null;
        run.dir = path.join(runsDir, id);
        runs.set(id, run);
        return run;
    }
    function save(run: Run, immediate = false) {
        run.updatedAt = now();
        const write = () => { saving.delete(run.id); try {
            const { dir, ...rest } = run;
            writeAtomic(path.join(run.dir, "run.json"), JSON.stringify(rest));
        }
        catch (e) {
            log(`workflow ${run.id}: save failed: ${(e as Error).message}`);
        } };
        if (immediate) {
            clearTimeout(saving.get(run.id));
            write();
            return;
        }
        if (!saving.has(run.id))
            saving.set(run.id, setTimeout(write, 50));
    }
    function append(run: Run, record: object) { fs.appendFileSync(path.join(run.dir, "journal.jsonl"), `${JSON.stringify(record)}\n`, { mode: 0o600 }); }
    // The journal as a cache: results per key in order, and agents started without a result.
    function journal(dir: string): Cache {
        const results = new Map<string, {
            agentId: string;
            result: unknown;
        }[]>(), unfinished = new Map<string, string[]>(), known = new Set<string>();
        let lines: string[] = [];
        try {
            lines = fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").split("\n").filter(Boolean);
        }
        catch { }
        const open = new Map<string, {
            type: string;
            key: string;
            agentId: string;
            result?: unknown;
        }>();
        for (const line of lines) {
            let r: {
                type: string;
                key: string;
                agentId: string;
                result?: unknown;
            };
            try {
                r = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (r.type === "started") {
                known.add(r.key);
                open.set(r.agentId, r);
            }
            if (r.type === "result") {
                known.add(r.key);
                open.delete(r.agentId);
                if (!results.has(r.key))
                    results.set(r.key, []);
                if (!(results.get(r.key) as {
                    agentId: string;
                    result: unknown;
                }[]).some((x) => x.agentId === r.agentId))
                    (results.get(r.key) as {
                        agentId: string;
                        result: unknown;
                    }[]).push({ agentId: r.agentId, result: r.result });
            }
        }
        for (const r of open.values()) {
            if (!unfinished.has(r.key))
                unfinished.set(r.key, []);
            if (!(unfinished.get(r.key) as string[]).includes(r.agentId))
                (unfinished.get(r.key) as string[]).push(r.agentId);
        }
        return { results, unfinished, known, any: lines.length > 0 };
    }
    return { runs, runsDir, summary, scan, load, save, append, journal };
}
