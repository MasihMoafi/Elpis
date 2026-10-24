// The workflow runner's rules (SPEC WR2, WR4) as properties over many random scripts, against a scripted executor:
// the same script and args resume fully cached; an edited call re-runs it and every call after it; pipeline() items
// never wait on one another; parallel() keeps input order with null for what threw; the limits hold.
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowRunner } from "../workflow-runner.mjs";
import { createTestTempDir, removeTestTempDir } from "./temp-root.mjs";
import { forAll } from "./property.mjs";

const homes = [];
test.after(() => { for (const dir of homes) removeTestTempDir(dir); });
const home = () => { const dir = createTestTempDir(path.join(os.tmpdir(), "wf-prop-")); homes.push(dir); return dir; };
const promptOf = (text) => text.split("\n\n").at(-1);
const META = "export const meta = { name: 'property', description: 'a generated script' }\n";
const lit = (v) => JSON.stringify(v);

// hold(prompt) -> a promise the turn waits for, or null; every turn answers "done: <prompt>".
function executor({ hold = () => null, delay = () => 0 } = {}) {
  let n = 0, active = 0;
  const ex = {
    turns: [], ended: [], maxActive: 0,
    async open() { return { threadId: `chat-${++n}` }; },
    async turn({ text, signal }) {
      const prompt = promptOf(text);
      ex.turns.push(prompt); active++; ex.maxActive = Math.max(ex.maxActive, active);
      try {
        const gate = hold(prompt);
        if (gate) await gate;
        const ms = delay(prompt);
        if (ms) await new Promise((resolve, reject) => { const t = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true }); });
        ex.ended.push(prompt);
        return { text: `done: ${prompt}`, outputTokens: 1 };
      } finally { active--; }
    },
  };
  return ex;
}
const runner = (ex, extra = {}) => new WorkflowRunner({ home: home(), executor: ex, retry: { attempts: 1, delays: [1] }, concurrency: 16, ...extra });
async function finish(r, options) {
  const started = await r.start({ parentThreadId: null, cwd: os.tmpdir(), model: "gpt-test", ...options });
  return new Promise((resolve) => {
    const on = (run) => { if (run.id === started.runId) { r.off("ended", on); resolve(run); } };
    r.on("ended", on);
    const now = r.read(started.runId);
    if (now.status !== "running") { r.off("ended", on); resolve({ ...now, id: started.runId }); }
  });
}
const prompt = (g, i) => `p${i} ${g.text(10)}`;

// A random script: single agents, parallel() groups and pipeline() chains, in any order, any of them empty.
function randomScript(g) {
  const steps = Array.from({ length: g.size(4) }, (_, s) => {
    const kind = g.pick(["one", "parallel", "pipeline"]);
    if (kind === "one") return `out.push(await agent(${lit(prompt(g, `${s}`))}))`;
    if (kind === "parallel") return `out.push(await parallel(${lit(Array.from({ length: g.size(4) }, (_, i) => prompt(g, `${s}.${i}`)))}.map((p) => () => agent(p))))`;
    const stages = g.int(1, 3);
    return `out.push(await pipeline(${lit(Array.from({ length: g.size(4) }, (_, i) => `item${s}.${i} ${g.text(6)}`))}, ${Array.from({ length: stages }, (_, k) => `(prev, item, i) => agent('s${k} ' + i + ' ' + String(prev).slice(-30))`).join(", ")}))`;
  });
  return `${META}const out = []\n${steps.join("\n")}\nreturn { out, args }`;
}

test("the same script and args resume fully cached, whatever the script (WR4)", async () => {
  await forAll(25, async (g) => {
    const script = randomScript(g), args = g.bool() ? g.json() : undefined;
    const first = executor(), r = runner(first);
    const done = await finish(r, { script, args });
    assert.equal(done.status, "completed", done.error);
    const again = executor(), r2 = new WorkflowRunner({ home: path.dirname(path.dirname(path.dirname(done.dir))), executor: again, concurrency: 16 });
    const resumed = await finish(r2, { script, args, resumeFromRunId: done.id });
    assert.equal(resumed.status, "completed", resumed.error);
    assert.deepEqual(again.turns, [], "no agent asked again");
    assert.deepEqual(resumed.result, done.result);
  });
});

test("an edited call runs again with every call after it; the calls before it come from the journal (WR4)", async () => {
  await forAll(25, async (g) => {
    const prompts = Array.from({ length: g.int(1, 8) }, (_, i) => prompt(g, i));
    const script = (list) => `${META}const out = []\nfor (const p of ${lit(list)}) out.push(await agent(p))\nreturn out`;
    const first = executor(), r = runner(first);
    const done = await finish(r, { script: script(prompts) });
    assert.equal(done.status, "completed", done.error);
    const at = g.int(0, prompts.length - 1);
    const edited = prompts.map((p, i) => (i === at ? `edited ${i} ${p}` : p));
    const again = executor(), r2 = new WorkflowRunner({ home: path.dirname(path.dirname(path.dirname(done.dir))), executor: again, concurrency: 16 });
    const resumed = await finish(r2, { script: script(edited), resumeFromRunId: done.id });
    assert.deepEqual(again.turns, edited.slice(at), `edited call ${at} of ${prompts.length}`);
    assert.deepEqual(resumed.result, edited.map((p) => `done: ${p}`));
  });
});

test("pipeline() items never wait on one another: one item held at any stage, every other item finishes (WR2)", async () => {
  await forAll(20, async (g) => {
    const n = g.int(1, 8), stages = g.int(1, 4), held = g.int(0, n - 1), at = g.int(0, stages - 1);
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const ex = executor({ hold: (p) => (p === `s${at} ${held}` ? gate : null), delay: () => g.int(0, 3) });
    const r = runner(ex);
    const items = Array.from({ length: n }, (_, i) => i);
    const run = finish(r, { script: `${META}return await pipeline(${lit(items)}, ${Array.from({ length: stages }, (_, k) => `(prev, item, i) => agent('s${k} ' + i)`).join(", ")})` });
    const others = items.filter((i) => i !== held).flatMap((i) => Array.from({ length: stages }, (_, k) => `s${k} ${i}`));
    try {
      for (const end = Date.now() + 10_000; !others.every((p) => ex.ended.includes(p)); ) {
        assert.ok(Date.now() < end, `items waited on held item ${held} at stage ${at}: ended ${ex.ended.join(", ")}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(!ex.turns.some((p) => Number(p.split(" ")[0].slice(1)) > at && p.endsWith(` ${held}`)), "the held item's later stages wait for it");
    } finally { release(); }
    const done = await run;
    assert.deepEqual(done.result, items.map((i) => `done: s${stages - 1} ${i}`));
  });
});

test("parallel() returns in input order whatever finishes first, with null for a thunk that threw (WR2)", async () => {
  await forAll(25, async (g) => {
    const kinds = Array.from({ length: g.size(10) }, () => g.pick(["agent", "agent", "throw", "reject", "undefined", "value"]));
    const thunks = kinds.map((kind, i) => ({
      agent: `() => agent('v${i}')`, throw: `() => { throw new Error('t${i}') }`, reject: `async () => { await agent('r${i}'); throw new Error('r${i}') }`,
      undefined: "() => undefined", value: `() => ({ i: ${i} })`,
    })[kind]);
    const r = runner(executor({ delay: () => g.int(0, 15) }));
    const done = await finish(r, { script: `${META}return await parallel([${thunks.join(", ")}])` });
    assert.equal(done.status, "completed", done.error);
    assert.deepEqual(done.result, kinds.map((kind, i) => (kind === "agent" ? `done: v${i}` : kind === "value" ? { i } : null)));
  });
});

test("the limits hold: concurrency, agents per run and items per call (WR2)", async () => {
  await forAll(20, async (g) => {
    const concurrency = g.int(1, 4), n = g.size(12);
    const ex = executor({ delay: () => 5 });
    const done = await finish(runner(ex, { concurrency }), { script: `${META}return (await parallel(${lit(Array.from({ length: n }, (_, i) => `c${i}`))}.map((p) => () => agent(p)))).length` });
    assert.equal(done.result, n);
    assert.equal(ex.ended.length, n, "every queued agent still runs");
    assert.ok(ex.maxActive <= concurrency, `${ex.maxActive} at once with a limit of ${concurrency}`);

    const maxAgents = g.int(0, 5), calls = g.int(0, 8);
    const capped = executor();
    const limited = await finish(runner(capped, { maxAgents }), { script: `${META}let ran = 0, refused = null
for (let i = 0; i < ${calls}; i++) { try { await agent('a' + i); ran++ } catch (e) { refused = e.name + ': ' + e.message; break } }
return { ran, refused }` });
    assert.equal(limited.result.ran, Math.min(calls, maxAgents));
    assert.equal(capped.turns.length, Math.min(calls, maxAgents));
    if (calls > maxAgents) assert.match(limited.result.refused, new RegExp(`^RangeError: .*limit of ${maxAgents} agents`));
    else assert.equal(limited.result.refused, null);

    const maxItems = g.int(0, 6), length = g.int(0, 8);
    const items = await finish(runner(executor(), { maxItems }), { script: `${META}try { return (await pipeline(${lit(Array.from({ length }, (_, i) => i))}, (x) => x * 2)) } catch (e) { return e.name + ': ' + e.message }` });
    if (length > maxItems) assert.match(items.result, new RegExp(`^RangeError: pipeline\\(\\) accepts at most ${maxItems} items \\(got ${length}\\)`));
    else assert.deepEqual(items.result, Array.from({ length }, (_, i) => i * 2));
  });
});
