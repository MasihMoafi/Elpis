// One workflow run's script, in its own thread: a script that loops forever or throws cannot stop the bridge,
// and stopping a run ends this thread. Every hook that needs the runner (agent, phase, log, workflow) is a
// message to it; parallel() and pipeline() are plain promise plumbing here.
import { parentPort, workerData } from "node:worker_threads";
import { compileScript } from "./workflow-script.mjs";

const { source, args, budgetTotal, spent, maxItems, scriptPath } = workerData;
const spentTokens = new BigInt64Array(spent);
let seq = 0;
const waiting = new Map();
parentPort.on("message", (m) => {
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.error) w.reject(Object.assign(new Error(m.error), { name: m.errorName ?? "Error" }));
  else w.resolve(m.value);
});
const ask = (msg) => new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); parentPort.postMessage({ ...msg, id }); });
const post = (msg) => parentPort.postMessage(msg);

const items = (list, what) => {
  if (!Array.isArray(list)) throw new TypeError(`${what} takes an array`);
  if (list.length > maxItems) throw new RangeError(`${what} accepts at most ${maxItems} items (got ${list.length}); split the work into several calls`);
};
const why = (e) => String(e?.message ?? e).slice(0, 300);

function hooksFor({ group, nested, scriptArgs }) {
  return (inside) => {
    let current = null;
    const agent = async (prompt, opts) => inside(await ask({ type: "agent", prompt, opts: opts === undefined ? {} : opts, phase: opts?.phase ?? current, group }));
    const parallel = async (thunks) => {
      items(thunks, "parallel()");
      const out = await Promise.all(thunks.map((t, i) => Promise.resolve().then(() => t()).catch((e) => { post({ type: "scriptError", where: `parallel() task ${i}`, message: why(e) }); return null; })));
      return inside(out.map((v) => (v === undefined ? null : v)));
    };
    const pipeline = async (list, ...stages) => {
      items(list, "pipeline()");
      if (stages.some((s) => typeof s !== "function")) throw new TypeError("pipeline() stages must be functions");
      const out = await Promise.all(list.map(async (item, index) => {
        let value = item;
        for (const [n, stage] of stages.entries()) {
          try { value = await stage(value, item, index); }
          catch (e) { post({ type: "scriptError", where: `pipeline() item ${index}, stage ${n + 1}`, message: why(e) }); return null; }
        }
        return value === undefined ? null : value;
      }));
      return inside(out);
    };
    const phase = (title) => { current = String(title); post({ type: "phase", title: current, group }); };
    const log = (message) => post({ type: "log", message: typeof message === "string" ? message : JSON.stringify(message), group });
    const budget = Object.freeze({
      total: budgetTotal ?? null,
      spent: () => Number(Atomics.load(spentTokens, 0)),
      remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - Number(Atomics.load(spentTokens, 0)))),
    });
    const workflow = async (ref, childArgs) => {
      if (nested) throw new Error("workflow() nesting is one level only: a workflow run by workflow() cannot run another");
      const child = await ask({ type: "workflow", ref: ref && typeof ref === "object" ? { scriptPath: ref.scriptPath } : ref });
      const compiled = compileScript(child.source, child.path);
      post({ type: "child", name: compiled.meta.name, phases: compiled.meta.phases ?? [] });
      return compiled.run(hooksFor({ group: compiled.meta.name, nested: true, scriptArgs: childArgs }));
    };
    return { agent, parallel, pipeline, phase, log, budget, workflow, args: inside(scriptArgs) };
  };
}

try {
  const value = await compileScript(source, scriptPath).run(hooksFor({ group: null, nested: false, scriptArgs: args }));
  let result;
  try { result = value === undefined ? null : JSON.parse(JSON.stringify(value)); }
  catch (e) { throw new Error(`The script's return value is not JSON: ${e.message}`); }
  post({ type: "done", value: result });
} catch (e) {
  post({ type: "failed", message: why(e), stack: String(e?.stack ?? "").split("\n").slice(0, 6).join("\n") });
}
