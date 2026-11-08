// Ported from dsh-superagent (MIT), tests/delivery.spec.ts and tests/role-models.spec.ts
import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sessions, type SessionOptions } from "./sessions.mts";
import { ExecutorStore } from "./store.mts";
import { ElpisAdapter } from "./adapters.mts";
import { SettingsSchema } from "./settings.mts";
import { FakeServer, waitFor } from "./fixtures.mts";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "router-sessions-")),
    server = new FakeServer();
  let store = new ExecutorStore(home);
  const options = (): SessionOptions => ({
    store,
    adapters: [new ElpisAdapter(server.connect)],
    subprocess: {
      spawn: () => {
        throw new Error("No subprocess expected");
      },
    },
  });
  let sessions = new Sessions(options());
  return {
    server,
    get store() {
      return store;
    },
    get sessions() {
      return sessions;
    },
    configure: (value: unknown) => {
      store.saveSettings(SettingsSchema.parse(value));
    },
    restart: () => {
      sessions.dispose();
      store.close();
      store = new ExecutorStore(home);
      sessions = new Sessions(options());
      return sessions;
    },
    stop: () => {
      sessions.dispose();
      store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
it("seeds each new role model without changing global defaults and keeps manual selections on resume", async t => {
  const h = fixture();
  t.after(h.stop);
  h.configure({
    eval: { model: { provider: "openai", model: "router-model" } },
    executor: { model: { provider: "openai", model: "worker-model", reasoningEffort: "high" } },
  });
  await h.sessions.ensure("main", "/project", "Main", "orchestrator");
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  const creates = h.server.calls.filter(call => call.method === "thread/start").map(call => call.params);
  assert.deepEqual(
    creates.map(call => call.model),
    ["router-model", "worker-model"],
  );
  assert.ok(!h.server.calls.some(call => call.method === "config/batchWrite"));
  const threadId = (h.store.session("worker-one") as { threadId: string }).threadId;
  h.server.threads.get(threadId)!.model = "manual-selection";
  h.configure({ executor: { model: { provider: "other", model: "replacement" } } });
  h.restart();
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  await h.sessions.ensure("worker-two", "/project", "Two", "worker");
  assert.equal(h.server.calls.findLast(call => call.method === "thread/start")?.params.model, "replacement");
  assert.equal(h.server.calls.filter(call => call.method === "thread/start").length, 3);
  assert.equal(h.server.threads.get(threadId)!.model, "manual-selection");
});

it("uses the corrected role choice after a runtime rejects creation without making a session", async t => {
  const h = fixture();
  t.after(h.stop);
  h.configure({ executor: { model: { provider: "openai", model: "unavailable-model" } } });
  h.server.failure = method =>
    method === "thread/start" ? Object.assign(new Error("Model unavailable"), { code: -32600 }) : undefined;
  await assert.rejects(h.sessions.ensure("worker-one", "/project", "One", "worker"), /Model unavailable/);
  h.configure({ executor: { model: { provider: "openai", model: "corrected-model" } } });
  h.server.failure = undefined;
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  assert.equal(h.server.calls.findLast(call => call.method === "thread/start")?.params.model, "corrected-model");
});
it("queues concurrent duplicate sends once and records reads only after runtime history contains them", async t => {
  const h = fixture();
  t.after(h.stop);
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  const read: string[] = [];
  h.sessions.on("session/event", (_session, event) => {
    if (event.type === "user/message") read.push(event.data.id);
  });
  await Promise.all([
    h.sessions.prompt("worker-one", "same", "Fix it", "queue"),
    h.sessions.prompt("worker-one", "same", "Fix it", "queue"),
  ]);
  assert.equal(h.server.calls.filter(call => call.method === "turn/start").length, 1);
  assert.deepEqual(read, ["router:same"]);
  assert.equal(await h.sessions.holds("worker-one", "same"), true);
});
it("recovers a receipt from remote history after a crash before its local acknowledgement", async t => {
  const h = fixture();
  t.after(h.stop);
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  await h.sessions.prompt("worker-one", "once", "Fix it", "queue");
  const record = h.store.session("worker-one") as { messages: { state: string; read: boolean }[] };
  record.messages[0]!.state = "sending";
  record.messages[0]!.read = false;
  h.store.saveSession("worker-one", record);
  h.restart();
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  await h.sessions.prompt("worker-one", "once", "Fix it", "queue");
  assert.equal(h.server.calls.filter(call => call.method === "turn/start").length, 1);
  assert.equal((h.store.session("worker-one") as typeof record).messages[0]!.read, true);
});
it("keeps an unknown creation outcome from starting a second worker and permits explicit binding", async t => {
  const h = fixture();
  t.after(h.stop);
  const original = h.server.connect;
  h.server.connect = () => {
    const conn = original(),
      call = conn.call;
    conn.call = async (method, params) => {
      const result = await call(method, params);
      if (method === "thread/start") throw new Error("socket hang up");
      return result;
    };
    return conn;
  };
  // Replace adapters before the first attach so this uses the interrupted connection.
  h.restart();
  await assert.rejects(h.sessions.ensure("worker-one", "/project", "One", "worker"), /socket hang up/);
  h.restart();
  await assert.rejects(h.sessions.ensure("worker-one", "/project", "One", "worker"), /creation outcome is unknown/);
  assert.equal(h.server.threads.size, 1);
  await h.sessions.adopt("worker-one", "elpis", [...h.server.threads.keys()][0]!);
  await h.sessions.prompt("worker-one", "task", "Continue", "queue");
  assert.equal(h.server.threads.size, 1);
});
it("injects background notices without waking a worker and includes them with its next real input", async t => {
  const h = fixture();
  t.after(h.stop);
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  await h.sessions.prompt("worker-one", "notice", "Background job ended", { inject: "Job ended" });
  assert.equal(h.server.calls.filter(call => call.method === "turn/start").length, 0);
  await h.sessions.prompt("worker-one", "task", "Continue", "queue");
  const record = h.store.session("worker-one") as { messages: { state: string; read: boolean }[] };
  assert.ok(record.messages.every(message => message.state === "sent" && message.read));
});
it("flushes a queued input when the preceding turn ends, preserving its identity across restart", async t => {
  const h = fixture();
  t.after(h.stop);
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  await h.sessions.prompt("worker-one", "first", "First", "queue");
  await h.sessions.prompt("worker-one", "second", "Second", "queue");
  assert.equal(h.server.calls.filter(call => call.method === "turn/start").length, 1);
  h.restart();
  await h.sessions.ensure("worker-one", "/project", "One", "worker");
  const record = h.store.session("worker-one") as { threadId: string };
  h.server.finish(record.threadId);
  await waitFor(() => assert.equal(h.server.calls.filter(call => call.method === "turn/start").length, 2));
  const all = h.store.session("worker-one") as { messages: { id: string; state: string }[] };
  assert.deepEqual(
    all.messages.map(message => message.id),
    ["router:first", "router:second"],
  );
});
