// One workflow run's script, in its own thread: a script that loops forever or throws cannot stop the bridge,
// and stopping a run ends this thread. Every hook that needs the runner (agent, phase, log, workflow) is a
// message to it; parallel() and pipeline() run inside the script's context.
import { parentPort, workerData } from "node:worker_threads";
import { compileScript } from "./workflow-script.mts";

const { source, args, budgetTotal, spent, maxItems, scriptPath } = workerData as {
  source: string; args: unknown; budgetTotal: number | null; spent: SharedArrayBuffer; maxItems: number; scriptPath: string;
};
if (!parentPort) throw new Error("A workflow worker needs a parent port.");
const port = parentPort;
const spentTokens = new BigInt64Array(spent);
let seq = 0;
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (reason: unknown) => void }>();
port.on("message", (m) => {
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.error) w.reject(Object.assign(new Error(m.error), { name: m.errorName ?? "Error" }));
  else w.resolve(m.value);
});
const ask = (msg: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); port.postMessage({ ...msg, id }); });
const post = (msg: Record<string, unknown>) => port.postMessage(msg);

const json = (value: unknown) => (value === undefined ? "null" : JSON.stringify(value));

// The runner's side of the script's hooks (workflow-script.mts makes the hooks themselves inside the script's context).
function hostFor({ group }: { group: string | null }) {
  return {
    agent: (prompt: string, opts: string, phase: string | null) => ask({ type: "agent", prompt, opts: JSON.parse(opts), phase, group }).then(json),
    post: (kind: string, a: unknown, b: unknown) => {
      if (kind === "phase") post({ type: "phase", title: a, group });
      else if (kind === "log") post({ type: "log", message: a, group });
      else if (kind === "scriptError") post({ type: "scriptError", where: a, message: b });
    },
    spent: () => Number(Atomics.load(spentTokens, 0)),
    workflow: async (ref: string, childArgs: string | undefined) => {
      const child = await ask({ type: "workflow", ref: JSON.parse(ref) }) as { source: string; path: string };
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
  const field = (key: "message" | "stack") => {
    if ((typeof e !== "object" || e === null) && typeof e !== "function") return undefined;
    if (key === "message" && "message" in e) return e.message;
    if (key === "stack" && "stack" in e) return e.stack;
    return undefined;
  };
  post({ type: "failed", message: String(field("message") ?? e).slice(0, 300), stack: String(field("stack") ?? "").split("\n").slice(0, 6).join("\n") });
}
