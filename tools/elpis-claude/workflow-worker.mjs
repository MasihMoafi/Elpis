// One workflow run's script, in its own thread: a script that loops forever or throws cannot stop the bridge,
// and stopping a run ends this thread. Every hook that needs the runner (agent, phase, log, workflow) is a
// message to it; parallel() and pipeline() run inside the script's context.
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

const json = (value) => (value === undefined ? "null" : JSON.stringify(value));

// The runner's side of the script's hooks (workflow-script.mjs makes the hooks themselves inside the script's context).
function hostFor({ group }) {
  return {
    agent: (prompt, opts, phase) => ask({ type: "agent", prompt, opts: JSON.parse(opts), phase, group }).then(json),
    post: (kind, a, b) => {
      if (kind === "phase") post({ type: "phase", title: a, group });
      else if (kind === "log") post({ type: "log", message: a, group });
      else if (kind === "scriptError") post({ type: "scriptError", where: a, message: b });
    },
    spent: () => Number(Atomics.load(spentTokens, 0)),
    workflow: async (ref, childArgs) => {
      const child = await ask({ type: "workflow", ref: JSON.parse(ref) });
      const compiled = compileScript(child.source, child.path);
      post({ type: "child", name: compiled.meta.name, phases: compiled.meta.phases ?? [] });
      return compiled.run(hostFor({ group: compiled.meta.name }), { args: childArgs, budgetTotal, maxItems, nested: true });
    },
  };
}

try {
  const text = await compileScript(source, scriptPath).run(hostFor({ group: null }), { args: args === undefined ? undefined : JSON.stringify(args), budgetTotal, maxItems });
  post({ type: "done", value: JSON.parse(text) });
} catch (e) {
  post({ type: "failed", message: String(e?.message ?? e).slice(0, 300), stack: String(e?.stack ?? "").split("\n").slice(0, 6).join("\n") });
}
