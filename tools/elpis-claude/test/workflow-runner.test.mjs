// The workflow runner's rules (SPEC WR1–WR7) against a scripted executor: every hook, the journal and its resume,
// retries, limits, budget, the opt-in check and the end notice. The bridge and the real engine are covered by
// workflow-bridge.test.mjs and workflow-engine.runtime.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { WorkflowRunner, agentKey, personAskedForWorkflow, noticeText, NOTICE_TAG } from "../workflow-runner.mjs";
import { parseScript } from "../workflow-script.mjs";

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "wf-runner-"));
const promptOf = (text) => text.split("\n\n").at(-1);
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

// answer(prompt, turn) -> text | { text } | throws; delay(prompt) -> ms.
function executor({ answer = (p) => `done: ${p}`, delay = () => 0 } = {}) {
  let n = 0, active = 0;
  const ex = {
    opened: [], turns: [], events: [], maxActive: 0,
    async open(o) { ex.opened.push(o); return { threadId: `chat-${++n}`, model: o.model }; },
    async turn({ threadId, text, outputSchema, signal }) {
      const prompt = promptOf(text);
      ex.turns.push({ threadId, prompt, text, outputSchema });
      active++; ex.maxActive = Math.max(ex.maxActive, active);
      ex.events.push(`start ${prompt}`);
      try {
        await sleep(delay(prompt), signal);
        const mine = ex.turns.filter((t) => t.threadId === threadId);
        const out = answer(mine[0].prompt, mine.length, text);
        ex.events.push(`end ${prompt}`);
        return { text: typeof out === "string" ? out : JSON.stringify(out), outputTokens: 10 };
      } finally { active--; }
    },
    closed: [],
    close(threadId) { ex.closed.push(threadId); },
  };
  return ex;
}

const runner = (ex, h = home(), extra = {}) => new WorkflowRunner({ home: h, executor: ex, retry: { attempts: 3, delays: [5, 5] }, ...extra });
const ended = (r, runId) => new Promise((resolve) => { const on = (run) => { if (run.id === runId) { r.off("ended", on); resolve(run); } }; r.on("ended", on); });
async function run(r, script, extra = {}) {
  const started = await r.start({ script, parentThreadId: "chat-parent", cwd: os.tmpdir(), model: "gpt-test", ...extra });
  return { started, run: await ended(r, started.runId) };
}
const META = `export const meta = { name: 'test', description: 'a test run', phases: [{ title: 'One' }, { title: 'Two' }] }\n`;
const journal = (dir) => fs.readFileSync(path.join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("meta must be a pure literal with a name and a description (WR2)", () => {
  assert.deepEqual(parseScript(`// lead\nexport const meta = { name: 'a', description: "b", phases: [{ title: \`T\`, detail: 'x' }], n: -1.5, ok: true, no: null }\nreturn 1`).meta,
    { name: "a", description: "b", phases: [{ title: "T", detail: "x" }], n: -1.5, ok: true, no: null });
  for (const bad of ["{ name: NAME, description: 'd' }", "{ name: 'a', description: f() }", "{ ...base, name: 'a', description: 'd' }",
    "{ name: `a${x}`, description: 'd' }", "{ name: 'a', description: 'd', phases: PHASES }"]) {
    assert.throws(() => parseScript(`export const meta = ${bad}\n`), /pure literal/, bad);
  }
  assert.throws(() => parseScript(`export const meta = { description: 'd' }\n`), /meta.name/);
  assert.throws(() => parseScript(`const x = 1\nexport const meta = { name: 'a', description: 'd' }`), /must begin/);
});

test("a TypeScript or broken script fails the launch, not later (WR2)", async () => {
  const r = runner(executor());
  await assert.rejects(r.start({ script: `export const meta = { name: 'x' }` }), /description/);
  const { run: done } = await run(r, `${META}const a: string = 'x'\nreturn a`);
  assert.equal(done.status, "failed");
  assert.match(done.error, /does not parse|TypeScript|Unexpected/);
});

test("Date.now(), Math.random() and new Date() are refused; dated values through args work (WR2)", async () => {
  const r = runner(executor());
  for (const call of ["Date.now()", "Math.random()", "new Date()", "Date()"]) {
    const { run: done } = await run(r, `${META}return ${call}`);
    assert.equal(done.status, "failed", call);
    assert.match(done.error, /not available in workflow scripts/, call);
  }
  const { run: ok } = await run(r, `${META}return { year: new Date(args.at).getUTCFullYear(), isArray: Array.isArray(args.list), max: Math.max(...args.list) }`, { args: { at: 0, list: [1, 3] } });
  assert.deepEqual(ok.result, { year: 1970, isArray: true, max: 3 });
});

test("agent() returns its final text, runs as a helper chat on the starting chat's model, and is journaled (WR2, WR4)", async () => {
  const ex = executor();
  const r = runner(ex);
  const { started, run: done } = await run(r, `${META}phase('One')\nconst a = await agent('say hi', { label: 'greeter' })\nlog('got ' + a)\nreturn a`);
  assert.equal(done.status, "completed");
  assert.equal(done.result, "done: say hi");
  assert.equal(ex.opened[0].model, "gpt-test");
  assert.equal(ex.opened[0].parentThreadId, "chat-parent");
  assert.match(ex.turns[0].text, /Your final message is returned to the workflow's script as data/);
  const records = journal(done.dir);
  assert.deepEqual(records.map((x) => x.type), ["launched", "started", "result"]);
  assert.equal(records[1].key, agentKey("say hi", { label: "greeter" }));
  assert.match(records[1].key, /^v2:[0-9a-f]{64}$/);
  assert.deepEqual({ label: records[1].label, phase: records[1].phase }, { label: "greeter", phase: "One" });
  assert.equal(records[2].result, "done: say hi");
  const read = r.read(started.runId);
  assert.equal(read.agents[0].threadId, "chat-1");
  assert.equal(read.agents[0].phase, "One");
  assert.equal(read.agents[0].state, "done");
  assert.deepEqual(read.logs.map((l) => l.message), ["got done: say hi"]);
  assert.ok(fs.existsSync(path.join(done.dir, `agent-${read.agents[0].id}.meta.json`)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(done.dir, "result.json"), "utf8")), "done: say hi");
  assert.equal(fs.readFileSync(started.scriptPath, "utf8").startsWith("export const meta"), true);
});

test("parallel() is a barrier; a throwing thunk gives null and the call never rejects (WR2)", async () => {
  const ex = executor({ delay: (p) => (p === "slow" ? 120 : 5) });
  const r = runner(ex);
  const { run: done } = await run(r, `${META}const out = await parallel([() => agent('fast'), () => agent('slow'), () => { throw new Error('boom') }])\nawait agent('after')\nreturn out`);
  assert.deepEqual(done.result, ["done: fast", "done: slow", null]);
  assert.ok(ex.events.indexOf("start after") > ex.events.indexOf("end slow"), ex.events.join(", "));
  assert.match(done.scriptErrors?.[0]?.message ?? r.read(done.id).scriptErrors[0].message, /boom/);
});

test("pipeline() has no barrier between stages; a throwing stage drops that item to null (WR2)", async () => {
  const ex = executor({ delay: (p) => (p === "s1 B" ? 150 : 5) });
  const r = runner(ex);
  const { run: done } = await run(r, `${META}return await pipeline(['A', 'B', 'C'],
    (item) => agent('s1 ' + item),
    (prev, item, i) => { if (item === 'C') throw new Error('drop C'); return agent('s2 ' + item + ' ' + i + ' after ' + prev) })`);
  assert.deepEqual(done.result, ["done: s2 A 0 after done: s1 A", "done: s2 B 1 after done: s1 B", null]);
  assert.ok(ex.events.indexOf("start s2 A 0 after done: s1 A") < ex.events.indexOf("end s1 B"), ex.events.join(", "));
});

test("a failing agent is retried with backoff, then null; the run still finishes (WR3)", async () => {
  const ex = executor({ answer: (p) => { if (p === "flaky") throw new Error("ECONNRESET"); return `done: ${p}`; } });
  const r = runner(ex);
  let tries = 0;
  const flakyOnce = executor({ answer: (p) => { if (p === "once" && tries++ === 0) throw new Error("rate limited (429)"); return `done: ${p}`; } });
  const { run: done } = await run(r, `${META}const a = await agent('flaky')\nconst b = await agent('fine')\nreturn { a, b }`);
  assert.equal(done.status, "completed");
  assert.deepEqual(done.result, { a: null, b: "done: fine" });
  assert.equal(ex.turns.filter((t) => t.prompt === "flaky").length, 3);
  const flaky = r.read(done.id).agents.find((a) => a.label === "flaky");
  assert.deepEqual([flaky.state, flaky.attempts], ["failed", 3]);
  assert.match(ex.turns.filter((t) => t.prompt === "flaky")[1].text, /Attempt 2: the last one failed with "ECONNRESET"/);
  assert.equal(journal(done.dir).filter((x) => x.type === "result").length, 1, "a dead agent's null is not journaled, so a resume runs it again");
  const r2 = runner(flakyOnce);
  const { run: second } = await run(r2, `${META}return await agent('once')`);
  assert.equal(second.result, "done: once");
  assert.equal(r2.read(second.id).agents[0].attempts, 2);
});

test("schema answers are validated, mismatches are asked again, and a third mismatch gives null (WR2)", async () => {
  const SCHEMA = { type: "object", properties: { n: { type: "integer" }, note: { type: "string" } }, required: ["n"] };
  const ex = executor({
    answer: (p, k) => p === "good" ? (k === 1 ? "not json" : { n: 2, note: null }) : p === "bad" ? { n: "two" } : { n: 1 },
  });
  const r = runner(ex);
  const { run: done } = await run(r, `${META}const S = ${JSON.stringify(SCHEMA)}\nreturn [await agent('good', { schema: S }), await agent('bad', { schema: S })]`);
  assert.deepEqual(done.result, [{ n: 2 }, null]);
  const good = ex.turns.filter((t) => t.threadId === ex.turns[0].threadId);
  assert.equal(good.length, 2);
  assert.match(good[1].text, /did not match the required JSON Schema: the answer is not a JSON object/);
  assert.deepEqual(good[0].outputSchema.required, ["n", "note"], "the engine gets a strict schema");
  assert.equal(good[0].outputSchema.additionalProperties, false);
  const bad = r.read(done.id).agents[1];
  assert.equal(ex.turns.filter((t) => t.threadId === bad.threadId).length, 3, "three tries, no outer retries");
  assert.equal(bad.state, "failed");
  const { run: unsatisfiable } = await run(r, `${META}try { await agent('x', { schema: { type: 'object', properties: {}, required: ['missing'] } }) } catch (e) { return e.message }`);
  assert.match(unsatisfiable.result, /unsatisfiable: required missing/);
});

test("concurrency is capped and the rest queue; agent and item limits throw (WR2)", async () => {
  const ex = executor({ delay: () => 20 });
  const r = runner(ex, home(), { concurrency: 3, maxAgents: 12, maxItems: 10 });
  const { run: done } = await run(r, `${META}const out = await parallel(Array.from({ length: 10 }, (_, i) => () => agent('job ' + i)))
    let tooMany = null
    try { await pipeline(Array.from({ length: 11 }, (_, i) => i), (x) => x) } catch (e) { tooMany = e.message }
    let capped = null
    try { for (let i = 0; i < 5; i++) await agent('more ' + i) } catch (e) { capped = e.message }
    return { n: out.filter(Boolean).length, tooMany, capped }`);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.result.n, 10);
  assert.equal(ex.maxActive, 3);
  assert.match(done.result.tooMany, /at most 10 items/);
  assert.match(done.result.capped, /limit of 12 agents/);
  assert.equal(ex.turns.length, 12);
});

test("budget is a hard ceiling: spent counts output tokens and agent() throws once it is reached (WR2)", async () => {
  const ex = executor();
  const r = runner(ex);
  const { run: done } = await run(r, `${META}const seen = [budget.total, budget.spent(), budget.remaining()]
    let n = 0
    try { while (budget.remaining() > 0) { await agent('step ' + n); n++ } } catch (e) { return { seen, n, error: e.message } }
    try { await agent('over') } catch (e) { return { seen, n, error: e.message, after: budget.spent() } }
    return { seen, n, after: budget.spent() }`, { budget: 25 });
  assert.deepEqual(done.result.seen, [25, 0, 25]);
  assert.equal(done.result.n, 3);
  assert.match(done.result.error, /token budget \(25\) is spent/);
  const { run: open } = await run(r, `${META}return [budget.total, budget.remaining()]`);
  assert.deepEqual(open.result, [null, null], "Infinity is not JSON; no budget means no ceiling");
});

test("resumeFromRunId: same script and args are fully cached; an edited call and everything after it run live (WR4)", async () => {
  const ex = executor();
  const h = home();
  const r = runner(ex, h);
  const script = `${META}const a = await agent('first')\nconst b = await parallel([() => agent('second'), () => agent('third')])\nconst c = await agent('fourth ' + a)\nreturn [a, ...b, c]`;
  const { run: one } = await run(r, script);
  assert.equal(ex.turns.length, 4);
  const { run: two } = await run(r, script, { resumeFromRunId: one.id });
  assert.equal(ex.turns.length, 4, "nothing ran again");
  assert.deepEqual(two.result, one.result);
  assert.ok(r.read(two.id).agents.every((a) => a.cached && a.threadId));
  assert.deepEqual(journal(two.dir).map((x) => x.type), ["launched", "started", "result", "started", "result", "started", "result", "started", "result"]);
  const edited = script.replace("agent('second')", "agent('second, edited')");
  const { run: three } = await run(r, edited, { resumeFromRunId: two.id });
  assert.deepEqual(ex.turns.slice(4).map((t) => t.prompt).sort(), ["fourth done: first", "second, edited", "third"].sort(),
    "first is cached; the edited call and every call after it in order run live");
  assert.equal(three.result[1], "done: second, edited");
  const { run: four } = await run(r, edited, { args: { changed: true }, resumeFromRunId: three.id });
  assert.equal(ex.turns.length, 7, "args the script ignores change no call");
  assert.deepEqual(four.result, three.result);
});

test("a restarted runtime resumes a running run from its journal without re-running finished agents (WR3)", async () => {
  const h = home();
  const ex1 = executor({ delay: (p) => (p.startsWith("slow") ? 10_000 : 5) });
  const r1 = runner(ex1, h);
  const script = `${META}phase('One')\nconst fast = await parallel([() => agent('fast 1'), () => agent('fast 2'), () => agent('slow 3')])\nphase('Two')\nconst last = await agent('last ' + fast.join('|'))\nreturn { fast, last }`;
  const { runId } = await r1.start({ script, parentThreadId: "chat-parent", cwd: os.tmpdir(), model: "gpt-test" });
  while (r1.read(runId).agents.filter((a) => a.state === "done").length < 2) await sleep(10);
  r1.close(); // the runtime dies: its script stops, the run stays running
  const state = JSON.parse(fs.readFileSync(path.join(r1.runsDir, runId, "run.json"), "utf8"));
  assert.equal(state.status, "running");
  state.owner = { pid: 999999, token: "gone" };
  fs.writeFileSync(path.join(r1.runsDir, runId, "run.json"), JSON.stringify(state));
  const ex2 = executor();
  const r2 = runner(ex2, h);
  const done = ended(r2, runId);
  assert.deepEqual(r2.recover(), [runId]);
  const finished = await done;
  assert.equal(finished.status, "completed");
  assert.deepEqual(ex2.turns.map((t) => t.prompt), ["slow 3", "last done: fast 1|done: fast 2|done: slow 3"]);
  const slow = r2.read(runId).agents.find((a) => a.label === "slow 3");
  assert.equal(slow.threadId, "chat-3", "the unfinished agent runs again in its own chat");
  assert.match(ex2.turns[0].text, /The workflow restarted before you finished/);
  assert.equal(journal(finished.dir).filter((x) => x.type === "launched").length, 2);
  assert.equal(r2.recover().length, 0, "a finished run is not resumed again");
});

test("a run owned by a live runtime is left alone; stop ends a run and resume continues it in place (WR3, WR7)", async () => {
  const h = home();
  const ex = executor({ delay: (p) => (p === "long" ? 10_000 : 5) });
  const r = runner(ex, h);
  const { runId } = await r.start({ script: `${META}const a = await agent('short')\nconst b = await agent('long')\nreturn [a, b]`, parentThreadId: "p", cwd: os.tmpdir() });
  while (!r.read(runId).agents.some((a) => a.label === "long" && a.state === "running")) await sleep(10);
  assert.deepEqual(runner(executor(), h).recover(), [], "another runtime does not take a live run");
  const stoppedEnd = ended(r, runId);
  const stopped = await r.stop(runId);
  assert.equal(stopped.status, "stopped");
  assert.equal((await stoppedEnd).notice.state, "pending", "the starting chat is told it stopped");
  assert.match(noticeText(await stoppedEnd), /<status>stopped<\/status>/);
  const quick = executor();
  const r2 = runner(quick, h);
  const resumed = ended(r2, runId);
  await r2.resume(runId);
  const done = await resumed;
  assert.equal(done.status, "completed");
  assert.deepEqual(quick.turns.map((t) => t.prompt), ["long"], "the finished agent is cached");
});

test("skip makes one running agent return null (WR7)", async () => {
  const ex = executor({ delay: (p) => (p === "stuck" ? 10_000 : 5) });
  const r = runner(ex);
  const { runId } = await r.start({ script: `${META}return [await agent('stuck'), await agent('next')]`, cwd: os.tmpdir() });
  let agent;
  while (!(agent = r.read(runId).agents.find((a) => a.state === "running"))) await sleep(10);
  const done = ended(r, runId);
  r.skip(runId, agent.id);
  assert.deepEqual((await done).result, [null, "done: next"]);
  assert.equal(r.read(runId).agents[0].state, "skipped");
});

test("workflow() runs a saved workflow inline, one level deep (WR2)", async () => {
  const h = home();
  fs.mkdirSync(path.join(h, "workflows"), { recursive: true });
  fs.writeFileSync(path.join(h, "workflows", "child.js"), `export const meta = { name: 'child', description: 'c', phases: [{ title: 'Inner' }] }\nphase('Inner')\nconst x = await agent('child ' + args.n)\nlet nested = null\ntry { await workflow('child', {}) } catch (e) { nested = e.message }\nreturn { x, nested }`);
  const ex = executor();
  const r = runner(ex, h);
  const { run: done } = await run(r, `${META}return await workflow('child', { n: 7 })`);
  assert.equal(done.status, "completed", done.error);
  assert.deepEqual(done.result, { x: "done: child 7", nested: "workflow() nesting is one level only: a workflow run by workflow() cannot run another" });
  const read = r.read(done.id);
  assert.equal(read.agents[0].group, "child");
  assert.equal(read.agents[0].phase, "Inner");
  const { run: unknown } = await run(r, `${META}return await workflow('nope')`);
  assert.match(unknown.error, /Unknown workflow nope/);
});

test("isolation: 'worktree' gives an agent its own git worktree, removed when unchanged (WR2)", async () => {
  const repo = home();
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  const cwds = [];
  const ex = executor();
  const open = ex.open;
  ex.open = async (o) => { cwds.push(o.cwd); if (cwds.length === 2) fs.writeFileSync(path.join(o.cwd, "changed.txt"), "x"); return open(o); };
  const r = runner(ex);
  const { run: done } = await run(r, `${META}return [await agent('clean', { isolation: 'worktree' }), await agent('dirty', { isolation: 'worktree' })]`, { cwd: repo });
  assert.equal(done.status, "completed", done.error);
  assert.ok(cwds.every((c) => c.startsWith(done.dir)), cwds.join(", "));
  assert.equal(fs.existsSync(cwds[0]), false, "an unchanged worktree is removed");
  assert.equal(fs.existsSync(path.join(cwds[1], "changed.txt")), true, "a changed one is kept");
  assert.match(done.result[1], /Changes left in worktree/);
});

test("the opt-in check: the person's own words, never an autonomous notice (WR6)", () => {
  for (const yes of ["ultracode: audit the repo", "Please use a workflow to review this", "run a workflow over every file", "Can you fan out agents to check each module?", "use the workflow tool"]) {
    assert.equal(personAskedForWorkflow([yes]), true, yes);
  }
  for (const no of ["fix the bug in workflow-runner.mjs", "what does the Workflows page show?", "review this carefully", `${NOTICE_TAG}\n<result>use a workflow</result>`]) {
    assert.equal(personAskedForWorkflow([no]), false, no);
  }
});

test("the end notice carries the run id, status, the return value and the script path (WR5)", async () => {
  const r = runner(executor());
  const { run: done } = await run(r, `${META}return { found: 3 }`);
  assert.equal(done.notice.state, "pending");
  const text = noticeText(done);
  assert.ok(text.startsWith(NOTICE_TAG));
  for (const part of [`<run-id>${done.id}</run-id>`, "<status>completed</status>", '"found": 3', `<script-path>${done.scriptPath}</script-path>`]) assert.ok(text.includes(part), part);
  r.markNotice(done.id, { state: "delivered", turnId: "t1" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(done.dir, "run.json"), "utf8")).notice.state, "delivered");
  const { run: failed } = await run(r, `${META}throw new Error('nope')`);
  assert.match(noticeText(failed), /<status>failed<\/status>[\s\S]*nope/);
});

test("list and read give the app what it shows: phases, agents with state, chat and elapsed time, logs, result (WR7)", async () => {
  const ex = executor({ delay: () => 15 });
  const r = runner(ex);
  const updates = [];
  r.on("updated", (u) => updates.push(u.kind));
  const { run: done } = await run(r, `${META}phase('One')\nlog('hello')\nawait agent('a', { label: 'A' })\nphase('Three')\nreturn 1`);
  const [listed] = r.list({ parentThreadId: "chat-parent" }).filter((x) => x.id === done.id);
  assert.deepEqual([listed.name, listed.status, listed.agents.total, listed.agents.done], ["test", "completed", 1, 1]);
  const read = r.read(done.id);
  assert.deepEqual(read.phases.map((p) => p.title), ["One", "Two", "Three"]);
  assert.equal(read.agents[0].label, "A");
  assert.ok(read.agents[0].elapsedMs >= 10);
  assert.deepEqual(read.logs.map((l) => l.message), ["hello"]);
  assert.equal(read.result, 1);
  for (const kind of ["launched", "phase", "log", "agent", "ended"]) assert.ok(updates.includes(kind), kind);
});
