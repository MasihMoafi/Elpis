// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/runtime.spec.ts, followups.spec.ts and tools.spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { waitFor } from "./executor/fixtures.mts";
import { fixture } from "./fixtures/app.mts";
import { savePrompts } from "./app/prompts.mts";
import { z } from "zod";
import { SettingsSchema } from "./policy.mts";

test("reopening a bound chat preserves its disabled source until a person enables it", async () => {
  const h = fixture();
  try {
    await h.app.settings.save(
      "source:elpis-chat",
      { enabled: false, config: { threadId: "old-chat" } },
      h.app.store.blockRevision("source:elpis-chat"),
      "panel",
    );
    await h.restart();
    const id = h.message("held", "Keep this request until the source is enabled");
    await h.app.pump();
    assert.equal(h.app.store.settings().sources["elpis-chat"]?.enabled, false);
    assert.equal(h.app.store.triggers.get(id), undefined);
    await h.app.settings.save(
      "source:elpis-chat",
      { enabled: true, config: { threadId: "mother" } },
      h.app.store.blockRevision("source:elpis-chat"),
      "panel",
    );
    await h.app.pump();
    assert.ok(h.app.store.triggers.get(id));
  } finally {
    await h.close();
  }
});

test("routes through native tools, delivers the complete goal, and recovers a worker and one reply after lost acknowledgement", async () => {
  const h = fixture();
  try {
    await h.app.start();
    const id = h.message("goal", `Inspect and verify this project. ${"context ".repeat(700)}END_CONSTRAINT`);
    await h.app.pump();
    h.loseReply();
    await h.route(id);
    await h.app.pump();
    const ticket = h.app.store.tickets.list()[0]!,
      worker = h.app.workers.sessions.nativeId(`worker-${ticket.id}`)!;
    assert.match(JSON.stringify(h.server.threads.get(worker)?.turns), /trigger\//);
    const full = await h.call(worker, "orchestrator_read", { resource: `trigger/${id}`, limit: 8000 });
    assert.match(JSON.stringify(full), /END_CONSTRAINT/);
    const start = h.server.calls.find(call => call.method === "thread/start")!;
    // Elpis sessions reach their tools through the tool server: the shared engine bridge never routes dynamic tool calls back
    // to the router (10 Nov).
    assert.equal(start.params.dynamicTools, undefined);
    // With approval policy "never" a tool that needs approval is refused, so the router's own tools are pre-approved.
    assert.equal(
      ((start.params.config as Record<string, unknown>)["mcp_servers.elpis_mother"] as Record<string, unknown>)
        .default_tools_approval_mode,
      "approve",
    );
    assert.match(
      JSON.stringify(h.server.calls.find(call => call.method === "turn/start")?.params.collaborationMode),
      /Assess proactive candidates yourself/,
    );
    await h.restart();
    await h.app.pump();
    assert.equal(
      h.server.calls.filter(call => call.method === "thread/start").length,
      2,
      "Router and worker sessions are reused",
    );
    await h.call(worker, "orchestrator_report", { state: "ready", summary: "Focused checks passed." });
    await h.app.pump();
    assert.equal(h.app.store.tickets.get(ticket.id)?.ended?.outcome, "completed");
    await h.call(h.main(), "orchestrator_reply", {
      ticket_id: ticket.id,
      purpose: "result",
      text: "Focused checks passed.",
    });
    h.app.store.db.prepare("UPDATE effect SET due=0 WHERE kind='reply'").run();
    await h.app.pump();
    await h.restart();
    await h.app.pump();
    assert.deepEqual(
      [...h.replies.values()],
      ["I will inspect the project and report the checks.", "Focused checks passed."],
    );
    assert.equal(h.app.store.receipts.waiting().length, 0);
  } finally {
    await h.close();
  }
  assert.equal(h.server.connections.size, 0);
});

test("an explicit worker reads its source image as an image and refuses a missing image reference", async () => {
  const h = fixture(),
    url = "data:image/png;base64,iVBORw0KGgo=";
  try {
    const id = h.message("picture", "Inspect this image [image:picture]");
    h.messages[0]!.images = [{ id: "picture", url }];
    await h.app.start();
    await h.app.pump();
    await h.route(id);
    await h.app.pump();
    const ticket = h.app.store.tickets.list()[0]!,
      worker = h.app.workers.sessions.nativeId(`worker-${ticket.id}`)!;
    assert.deepEqual(await h.call(worker, "orchestrator_read", { resource: `elpis-chat/${id}/image/picture` }), {
      image_url: url,
    });
    assert.equal(
      (await h.server.tool(worker, "orchestrator_read", { resource: `elpis-chat/${id}/image/missing` })).success,
      false,
    );
    assert.equal(
      (await h.server.tool(worker, "orchestrator_read", { resource: "elpis-chat/another-trigger/image/picture" }))
        .success,
      false,
    );
    const message = await h.call(worker, "orchestrator_read", { resource: `elpis-chat/${id}/message` });
    assert.match(JSON.stringify(message), /image\/picture/);
    assert.doesNotMatch(JSON.stringify(message), /base64/);
  } finally {
    await h.close();
  }
});

test("handles follow-ups through their worker, hands unrelated work back, and refuses cross-ticket reads and ended tools", async () => {
  const h = fixture();
  try {
    await h.app.start();
    const id = h.message("goal", "Inspect the project");
    await h.app.pump();
    await h.route(id);
    await h.app.pump();
    const first = h.app.store.tickets.list()[0]!,
      worker = h.app.workers.sessions.nativeId(`worker-${first.id}`)!;
    const followup = h.message("followup", "Now fix an unrelated app");
    await h.app.pump();
    assert.equal(h.app.engine.candidate(followup), undefined);
    const denied = await h.server.tool(h.main(), "orchestrator_route", {
      decisions: [{ kind: "ignore", trigger_id: followup, reason: "Ignore" }],
    });
    assert.match(JSON.stringify(denied.value), /refused/);
    await h.call(worker, "orchestrator_trigger_handback", {
      trigger_id: followup,
      reason: "This asks for another app",
    });
    await h.app.pump();
    await h.route(followup, "fix-other-app");
    await h.app.pump();
    assert.equal(h.app.store.tickets.list().length, 2);
    const other = h.app.store.tickets.list().find(ticket => ticket.id !== first.id)!;
    assert.equal((await h.server.tool(worker, "orchestrator_read", { resource: `ticket/${other.id}` })).success, false);
    await h.call(worker, "orchestrator_report", { state: "ready", summary: "Inspected." });
    assert.equal(
      (await h.server.tool(worker, "orchestrator_thread_follow", { thread: "github:5", reason: "Context" })).success,
      false,
    );
  } finally {
    await h.close();
  }
});

test("a malformed routing item leaves valid siblings intact and shell setup remains panel-only", async () => {
  const h = fixture();
  try {
    await h.app.start();
    const id = h.message("first", "Inspect");
    await h.app.pump();
    const result = await h.call(h.main(), "orchestrator_route", {
      decisions: [
        { kind: "accept", trigger_id: id, title: "Missing required fields" },
        {
          kind: "accept",
          trigger_id: id,
          title: "Inspect",
          worktree_name: "inspect-project",
          acknowledgement: "I will inspect the project.",
        },
      ],
    });
    assert.match(JSON.stringify(result), /refused/);
    assert.equal(h.app.store.tickets.list().length, 1);
    const forbidden = await h.server.tool(h.main(), "orchestrator_settings_save", {
      block: "executor",
      revision: h.app.store.blockRevision("executor"),
      value: { ...h.app.store.settings().executor, prepare: "unsafe external command" },
    });
    assert.equal(forbidden.success, false);
    await h.app.pump();
    await waitFor(() => assert.equal(h.app.store.tickets.list()[0]?.assignments.at(-1)?.state, "running"));
  } finally {
    await h.close();
  }
});

test("updated notices reach the next turn without waking the main session, and prompt revisions remain inspectable", async () => {
  const h = fixture();
  try {
    await h.app.start();
    const sessions = h.app.workers.sessions;
    sessions.notify("setting", { version: 1 }, "Settings updated");
    await h.app.pump();
    sessions.notify("setting", { version: 2 }, "Settings updated");
    await h.app.pump();
    assert.equal(h.server.calls.filter(call => call.method === "turn/start").length, 0);
    await sessions.prompt(h.app.masterId, "inspect-notices", "Read the updates", "queue");
    const history = JSON.stringify(h.server.threads.get(h.main())?.turns);
    assert.match(history, /version\\":1/);
    assert.match(history, /version\\":2/);
    const first = sessions.promptVersion(h.app.masterId).revision;
    h.server.finish(h.main());
    await waitFor(() => assert.equal(sessions.agents.get(h.app.masterId)?.status, "idle"));
    const current = h.app.prompts.current();
    await savePrompts(
      { store: h.app.store, prompts: h.app.prompts, sessions },
      { ...current.config, communication: `${current.config.communication}\nReport concrete evidence.` },
      current.revision,
      "panel",
    );
    await sessions.prompt(h.app.masterId, "new-prompts", "Continue", "queue");
    assert.ok(sessions.mayRead(h.app.masterId, first));
    assert.equal(sessions.promptVersion(h.app.masterId).revision, current.revision + 1);
    assert.equal(sessions.mayRead(h.app.masterId, current.revision + 20), false);
    assert.match(
      JSON.stringify(h.server.calls.findLast(call => call.method === "turn/start")?.params.collaborationMode),
      /Report concrete evidence/,
    );
  } finally {
    await h.close();
  }
});

test("native budget health requires a scheduled retry, survives tool results, and clears on recovery without exposing errors", async () => {
  const h = fixture();
  try {
    await h.app.start();
    await h.app.workers.sessions.prompt(h.app.masterId, "budget-test", "Inspect", "queue");
    const error = { code: "budget_exceeded", message: "secret credential must not appear" };
    h.server.emit(h.main(), "error", { error, willRetry: true });
    h.server.emit(h.main(), "error", { error, willRetry: true });
    assert.equal(h.app.health.models?.state, "error");
    assert.match(h.app.health.models?.detail ?? "", /retried 2 times/);
    assert.doesNotMatch(JSON.stringify(h.app.health.models), /secret|credential/);
    h.server.emit(h.main(), "item/completed", { item: { type: "commandExecution" } });
    assert.equal(h.app.health.models?.state, "error");
    h.server.emit(h.main(), "item/completed", { item: { type: "agentMessage", text: "Recovered" } });
    assert.equal(h.app.health.models?.state, "ready");
    h.server.emit(h.main(), "error", { error, willRetry: false });
    assert.equal(h.app.health.models?.state, "ready");
  } finally {
    await h.close();
  }
});

test("native proactive assessment rejects a short routing decision and incomplete evidence before creating an inferred mandate", async () => {
  const h = fixture({
    settings: () =>
      SettingsSchema.parse({
        eval: { mode: "auto", model: { provider: "openai", model: "router" } },
        executor: { model: { provider: "openai", model: "worker" } },
        sources: { probe: { enabled: true, config: {} } },
        policy: {
          sources: { probe: { allowed: [{ id: "person" }] } },
          rules: [{ id: "copy", name: "Copy fixes", enabled: true, instruction: "Correct existing typos" }],
        },
      }),
  });
  try {
    h.app.sources.register({
      kind: "probe",
      title: { en: "Probe", zh: "Probe" },
      description: { en: "", zh: "" },
      schema: z.object({}),
      fields: [],
      health: [],
      scope: () => ({ listened: true, observed: true }),
      policy: {
        schema: z.object({ allowed: z.array(z.object({ id: z.string() })) }),
        fields: [],
        explicit: { en: "Mention", zh: "Mention" },
      },
    });
    await h.app.start();
    h.app.engine.receive({
      id: "typo",
      source: "probe",
      actor: { source: "probe", id: "person" },
      human: true,
      at: new Date().toISOString(),
      threads: [{ source: "probe", id: "1" }],
      text: "Please correct teh to the in the existing heading.",
      meta: {},
    });
    await h.app.pump();
    assert.equal(h.app.engine.candidate("typo")?.strength, "inferred");
    const shortcut = await h.server.tool(h.main(), "orchestrator_route", {
      decisions: [
        {
          kind: "accept",
          trigger_id: "typo",
          title: "Fix typo",
          worktree_name: "fix-typo",
          acknowledgement: "I will correct the typo.",
        },
      ],
    });
    assert.match(JSON.stringify(shortcut.value), /refused/);
    assert.equal(h.app.store.tickets.list().length, 0);
    await h.call(h.main(), "orchestrator_eval", { trigger_id: "typo" });
    const decision = {
      trigger_id: "typo",
      decision: "accept",
      direction: {
        implementation_requested: true,
        target_basis: "specified",
        requires_design_decision: false,
        evidence: "The request names both spellings.",
      },
      rule_assessments: [{ rule_id: "copy", matched: true, reason: "An existing typo" }],
      title: "Fix typo",
      worktree_name: "fix-typo",
      scope: "One heading",
      reason: "Specified correction",
    };
    assert.equal((await h.server.tool(h.main(), "orchestrator_eval_decide", decision)).success, false);
    assert.equal(h.app.store.tickets.list().length, 0);
    await h.call(h.main(), "orchestrator_eval_decide", {
      ...decision,
      intent_evidence: "Please correct teh to the in the existing heading.",
      acknowledgement: "I will correct the typo.",
    });
    assert.equal(h.app.store.tickets.list()[0]?.mandate.strength, "inferred");
    assert.deepEqual(h.app.store.tickets.list()[0]?.mandate.basis.rules, ["copy"]);
  } finally {
    await h.close();
  }
});
