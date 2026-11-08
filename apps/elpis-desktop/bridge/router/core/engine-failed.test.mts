import { describe, it } from "node:test";
import { expect } from "expect";
import { UserError, followupOwners, key, runningAssignment, ticketStage } from "./index.mts";
import type { Policy } from "./index.mts";
import { member, guest, trigger, harness, accepted } from "./engine.fixtures.mts";

describe("ticket commands", () => {
  it("ends a ticket by the same rule on a close and on a ready report: once no PR it opened is open, as the latest of them ended", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    // It started from someone's PR and opened its own.
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-5" }, false);
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-7" }, true);
    h.engine.threadClosed({ source: "gh", id: "pr-7" }, "merged", "2026-09-23T00:00:00Z");
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: "merged" });
    // A person's comment resumes it; its ready report ends it again as its own PR did, though the one it started from is open.
    h.tick(10);
    h.engine.receive(trigger("2", { threads: [{ source: "gh", id: "pr-5" }] }));
    h.settle();
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty("ended");
    h.engine.report(ticketId, { state: "ready", summary: "Answered" });
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: "merged" });
    // The PR it started from closing later changes nothing.
    h.engine.threadClosed({ source: "gh", id: "pr-5" }, "closed", "2026-09-23T00:00:30Z");
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: "merged" });
    // A ticket that opened no PR ends when the one it follows closes, as it did.
    const other = accepted(h, "3", "t3").ticketId!;
    h.engine.bindThread(other, { source: "gh", id: "pr-8" }, false);
    h.engine.report(other, { state: "ready", summary: "Pushed to their branch" });
    expect(h.repo.tickets.get(other)).not.toHaveProperty("ended");
    h.engine.threadClosed({ source: "gh", id: "pr-8" }, "closed", "2026-09-23T00:01:00Z");
    expect(h.repo.tickets.get(other)!.ended).toMatchObject({ outcome: "closed" });
  });
  it("stops following a Thread whose Subscription a person removes", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-7" }, true);
    expect(h.engine.unsubscribe("gh:pr-7")).toBe(true);
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty("follows");
    // Its ready report completes it, since it follows no Thread now.
    h.engine.report(ticketId, { state: "ready", summary: "Done" });
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: "completed" });
  });
  it("follows a Source's Threads, and ends once no Thread of its own is open, unless resumed work has not finished", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const close = (id: string, outcome: "merged" | "closed", at: string) => {
      const open = h.repo.tickets.open().map(ticket => ticket.id);
      h.engine.threadClosed({ source: "gh", id }, outcome, at);
      return open.filter(item => h.repo.tickets.get(item)!.ended);
    };
    expect(h.engine.bindThread(ticketId, { source: "gh", id: "pr-9" }, false)).toMatchObject({
      follows: [{ thread: "gh:pr-9", own: false }],
    });
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-10" }, true);
    expect(h.repo.threads.get("gh:pr-9")!.subscriptions).toEqual([ticketId]);
    // The Thread it started from closes while its own is open: it records the close and works on.
    expect(close("pr-9", "closed", "2026-09-23T00:00:00Z")).toEqual([]);
    expect(h.repo.tickets.get(ticketId)).toMatchObject({
      follows: [{ thread: "gh:pr-9", closed: { outcome: "closed" } }, { thread: "gh:pr-10" }],
    });
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty("ended");
    // Its own closes too: it ends as that one did, when it did, once.
    expect(close("pr-10", "merged", "2026-09-23T00:00:01Z")).toEqual([ticketId]);
    expect(h.repo.tickets.get(ticketId)).toMatchObject({
      ended: { by: "executor", outcome: "merged", at: "2026-09-23T00:00:01.000Z" },
    });
    expect(close("pr-10", "merged", "2026-09-23T00:00:01Z")).toEqual([]);
    expect(() => h.engine.bindThread(ticketId, { source: "gh", id: "pr-11" }, true)).toThrow(
      new UserError("ticketEnded"),
    );
    // A ticket retried after its PR closed but before the close was reported works on until it reports ready.
    const other = accepted(h, "2", "t2").ticketId!;
    h.engine.bindThread(other, { source: "gh", id: "pr-12" }, true);
    h.engine.report(other, { state: "failed", summary: "tests fail" });
    h.tick(10);
    h.engine.retryTicket(other);
    expect(close("pr-12", "closed", "2026-09-23T00:00:05Z")).toEqual([]);
    expect(h.repo.tickets.get(other)!.ended).toBeUndefined();
    h.engine.report(other, { state: "ready", summary: "done" });
    expect(h.repo.tickets.get(other)).toMatchObject({ ended: { outcome: "closed" } });
  });

  it("retries a ticket that reported failed with a new Assignment, and asks only a waiting worker for its status", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError("notRetryable"));
    expect(h.engine.requestStatus(ticketId)).toBe(false);
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([]);
    h.engine.report(ticketId, { state: "waiting", summary: "idle" });
    expect(h.engine.requestStatus(ticketId)).toBe(true);
    expect(h.repo.tickets.get(ticketId)!.inputs).toEqual([
      expect.objectContaining({ kind: "text", text: expect.stringContaining("status-only") }),
    ]);
    h.engine.report(ticketId, { state: "failed", summary: "broke" });
    const retried = h.engine.retryTicket(ticketId);
    expect(retried.assignments).toEqual([
      expect.objectContaining({ state: "ended", endedReason: "retried" }),
      expect.objectContaining({ state: "pending" }),
    ]);
    expect(h.executor.stop).toHaveBeenCalledTimes(1);
    expect(h.executor.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: ticketId }),
      retried.assignments[1]!,
    );
  });
});

describe("failed deliveries", () => {
  it("forgets a failed delivery once a new Assignment takes over or the ticket ends", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const failed = () => {
      h.engine.deliveryFailed(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id, "Session busy");
      expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: "Session busy" });
    };
    failed();
    h.engine.report(ticketId, { state: "blocked", summary: "needs access" });
    h.engine.retryTicket(ticketId);
    h.settle();
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty("delivery");
    failed();
    h.engine.stopTicket(ticketId);
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty("delivery");
  });
});

describe("problems", () => {
  it("dismisses the problem an unavailable Decision shows, and only such a Decision", () => {
    const h = harness();
    const decision = accepted(h);
    expect(() => h.engine.dismiss(decision.id)).toThrow(new UserError("unknownProblem"));
    h.engine.receive(trigger("2", { threads: [{ source: "chat", id: "t2" }] }));
    h.pump();
    const unavailable = h.decide(h.requests.at(-1)!, { kind: "unavailable", reason: "model down" });
    expect(h.engine.dismiss(unavailable.id)).toMatchObject({ kind: "unavailable", dismissed: true });
    expect(h.repo.decisions.get(unavailable.id)).toMatchObject({ dismissed: true });
  });
});

describe("retry after a failed delivery", () => {
  it("starts a new Assignment for a ticket whose Input keeps failing to reach its worker, which takes the Input", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "failed", summary: "tests fail" });
    // A person's answer goes to the failed worker, and delivering it fails.
    h.tick(5);
    h.engine.receive(trigger("2"));
    const answered = h.repo.tickets.get(ticketId)!;
    expect(answered.undelivered).toHaveLength(1);
    h.engine.deliveryFailed(ticketId, runningAssignment(answered)!.id, "Session gone");
    expect(ticketStage(h.repo.tickets.get(ticketId)!)).toEqual({ stage: "person", action: "delivery" });
    const retried = h.engine.retryTicket(ticketId);
    expect(retried.assignments.map(item => item.state)).toEqual(["ended", "pending"]);
    expect(retried).not.toHaveProperty("delivery");
    expect(retried.undelivered).toHaveLength(1);
  });
});

describe("Evals across Policy versions, revoked Mandates and mixed batches", () => {
  it("queues an Eval's batch again when it is decided under an older Policy, such as after an upgrade changed the version", () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    const candidate = h.requests.at(-1)!;
    // An upgrade changes the version without a Policy change being reported.
    h.setVersion("v2");
    expect(h.decide(candidate, { kind: "accept", title: "Fix", scope: "small", reason: "r" })).toMatchObject({
      kind: "unavailable",
      reason: [{ code: "policyChanged" }],
    });
    expect(h.repo.threads.get("chat:t1")).toMatchObject({ pending: ["1"] });
    h.pump();
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: "v2", triggers: [expect.objectContaining({ id: "1" })] });
  });
  it("queues a person's message for Eval when the only ticket it reached cannot resume under the Policy now, and says it reached none", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "ready", summary: "Done" });
    h.settle();
    h.setVersion("revoked");
    h.tick(5);
    h.engine.receive(trigger("2"));
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() });
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["2"]);
    expect(followupOwners(trigger("2"), h.repo)).toEqual([]);
  });
  it("queues a person's message that waited out a pause for Eval when the ticket it reached cannot resume once the pause lifts", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "ready", summary: "Done" });
    h.settle();
    h.setPaused(true);
    h.tick(5);
    h.engine.receive(trigger("2"));
    h.pump();
    expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1);
    h.setVersion("revoked");
    h.setPaused(false);
    h.engine.evaluateDue();
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [], ended: expect.anything() });
    expect(h.repo.threads.get("chat:t1")!.pending.includes("2") || h.engine.candidate("2") !== undefined).toBe(true);
  });
  it("takes a new ticket's origin and acknowledgement from the admissible Trigger that gave its batch its strength", () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.tick(1);
    h.engine.receive(
      trigger("2", {
        human: false,
        actor: { source: "chat", id: "ci-bot" },
        channel: { source: "chat", thread: "chat:t1", address: { message: "bot" } },
      }),
    );
    h.pump();
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(["1", "2"]);
    const decision = h.decide(h.requests.at(-1)!, {
      kind: "accept",
      title: "Fix",
      scope: "small",
      reason: "r",
      acknowledgement: "ok",
    });
    expect(h.repo.tickets.get(decision.ticketId!)!.origin).toEqual({ triggerId: "1", triggerIds: ["1", "2"] });
    expect(h.outbox).toEqual([expect.objectContaining({ id: key("ack", "1"), channel: trigger("1").channel })]);
  });
});

describe("gaps", () => {
  it("takes a mixed batch's strength, actor and basis from its strongest admissible Trigger, the latest of equal strength", () => {
    // A guest's message is admitted as inferred, as on a Thread a ticket follows.
    const gate: Policy["gate"] = t =>
      t.actor.id === "alice"
        ? { admissible: true, strength: "explicit", basis: { via: "listed" } }
        : { admissible: true, strength: "inferred", basis: { via: "followup" } };
    for (const order of [
      ["guest", "alice"],
      ["alice", "guest"],
    ]) {
      const h = harness({ gate });
      order.forEach((who, index) => {
        h.tick(1);
        h.engine.receive(trigger(String(10 + index), { actor: who === "alice" ? member : guest }));
      });
      h.pump();
      const alice = String(10 + order.indexOf("alice"));
      expect(h.repo.threads.get("chat:t1")!.evaluating).toMatchObject({
        strength: "explicit",
        actor: member,
        basis: { via: "listed" },
        primary: alice,
      });
    }
    const named = harness({
      gate: t => ({ admissible: true, strength: "explicit", basis: { via: "listed", sender: t.actor.id } }),
    });
    named.engine.receive(trigger("1", { actor: { source: "chat", id: "bob" } }));
    named.tick(1);
    named.engine.receive(trigger("2", { actor: { source: "chat", id: "carol" } }));
    named.pump();
    expect(named.repo.threads.get("chat:t1")!.evaluating).toMatchObject({
      actor: { id: "carol" },
      basis: { sender: "carol" },
      primary: "2",
    });
  });
  it("changes nothing and delivers nothing on a late start of an Assignment a retry replaced", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const first = h.repo.tickets.get(ticketId)!.assignments[0]!.id;
    h.engine.report(ticketId, { state: "failed", summary: "broke" });
    h.engine.retryTicket(ticketId);
    const before = h.repo.tickets.get(ticketId)!;
    const delivered = h.delivered.length;
    h.engine.assignmentStarted(ticketId, first);
    h.settle({ launch: false });
    expect(h.repo.tickets.get(ticketId)!.assignments).toEqual(before.assignments);
    expect(h.delivered).toHaveLength(delivered);
  });
  it("records a stop that names an unknown or ended ticket as ignored", () => {
    const h = harness();
    const ended = accepted(h).ticketId!;
    h.engine.report(ended, { state: "ready", summary: "Done" });
    for (const [id, ticketId] of [
      ["2", "missing"],
      ["3", ended],
    ] as const) {
      h.tick(1);
      h.engine.receive(trigger(id, { threads: [{ source: "chat", id: `t${id}` }] }));
      h.pump();
      expect(h.decide(h.requests.at(-1)!, { kind: "stop", ticketId, reason: "stop it" })).toMatchObject({
        kind: "ignore",
        reason: [{ code: "stopUnknown" }],
      });
    }
    expect(h.repo.tickets.get(ended)!.ended).toMatchObject({ by: "executor", outcome: "completed" });
  });
  it("refuses a direct decision on a Trigger the gate does not admit, and leaves the queue as it was", () => {
    const h = harness();
    h.engine.receive(trigger("1", { human: false }));
    const pending = h.repo.threads.get("chat:t1")!.pending;
    expect(() => h.engine.decide("1", { kind: "ignore", reason: "noise" })).toThrow(
      new UserError("notAdmissible", { reason: "not human" }),
    );
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(pending);
    expect(h.repo.decisions.byThread("chat:t1")).toEqual([]);
  });
  it("refuses to retry a ticket a person stopped after its failed report", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "failed", summary: "broke" });
    h.engine.stopTicket(ticketId);
    expect(() => h.engine.retryTicket(ticketId)).toThrow(new UserError("notRetryable"));
  });
  it("answers a question once, sends a result only for finished work, and the same result once", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.engine.report(ticketId, { state: "progress", summary: "It reads the config.", answers: "2" });
    expect(h.engine.reply({ purpose: "answer", triggerId: "2", text: "It reads the config." })).toMatchObject({
      reused: false,
    });
    expect(() => h.engine.reply({ purpose: "answer", triggerId: "2", text: "Something else." })).toThrow(
      new UserError("noAnswer"),
    );
    expect(() => h.engine.reply({ purpose: "result", ticketId, text: "Done" })).toThrow(new UserError("notReady"));
    h.engine.report(ticketId, { state: "ready", summary: "Done" });
    const sent = h.outbox.length;
    expect(h.engine.reply({ purpose: "result", ticketId, text: "Done" })).toMatchObject({ reused: false });
    expect(h.engine.reply({ purpose: "result", ticketId, text: "Done" })).toMatchObject({ reused: true });
    expect(h.outbox).toHaveLength(sent + 1);
    // A ticket whose PR closed unmerged, or that a person stopped, has no result to send.
    const closed = accepted(h, "5", "t5").ticketId!;
    h.engine.bindThread(closed, { source: "gh", id: "pr-1" }, true);
    h.engine.threadClosed({ source: "gh", id: "pr-1" }, "closed", "2026-09-23T00:01:00Z");
    expect(() => h.engine.reply({ purpose: "result", ticketId: closed, text: "x" })).toThrow(new UserError("notReady"));
    const stopped = accepted(h, "6", "t6").ticketId!;
    h.engine.stopTicket(stopped);
    expect(() => h.engine.reply({ purpose: "result", ticketId: stopped, text: "x" })).toThrow(
      new UserError("notReady"),
    );
  });
  it("keeps an Eval's deadline on a repeated delivery, refuses to queue a held Trigger again, and puts expired Triggers first", () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    const evalId = h.requests[0]!.evalId;
    h.engine.candidateDelivered(evalId);
    const deadline = h.repo.threads.get("chat:t1")!.evaluating!.deadline;
    h.tick(30);
    h.engine.candidateDelivered(evalId);
    expect(h.repo.threads.get("chat:t1")!.evaluating!.deadline).toBe(deadline);
    expect(h.engine.reevaluate("1")).toBe(false);
    // A Trigger that arrives meanwhile queues behind the expired one, and the fresh Eval takes both in that order.
    h.tick(1);
    h.engine.receive(trigger("2", { actor: guest }));
    h.tick(30);
    h.engine.evaluateDue();
    expect(h.repo.threads.get("chat:t1")!.evaluating!.triggerIds).toEqual(["1", "2"]);
    expect(h.repo.decisions.byThread("chat:t1")).toEqual([]);
  });
});

describe("final review", () => {
  it("ignores an Eval an earlier version left holding only a Trigger that started a ticket, instead of recording it unavailable", () => {
    const h = harness();
    const decision = accepted(h);
    // An earlier version could leave an Eval holding the Trigger after it started a ticket.
    const thread = h.repo.threads.get("chat:t1")!;
    h.repo.threads.save({
      ...thread,
      evaluating: {
        id: "old-eval",
        threadKey: "chat:t1",
        triggerIds: ["1"],
        primary: "1",
        strength: "explicit",
        actor: member,
        basis: { via: "listed" },
        policyVersion: "v1",
        startedAt: "",
        deadline: "2999-01-01T00:00:00.000Z",
      },
    });
    expect(h.engine.decide("1", { kind: "accept", title: "Again", scope: "small", reason: "replayed" })).toEqual(
      decision,
    );
    expect(h.repo.decisions.byThread("chat:t1").at(-1)).toMatchObject({
      kind: "ignore",
      reason: [{ code: "startedTicket", triggerId: "1", values: { ticket: decision.ticketId } }],
    });
    expect(h.repo.decisions.byThread("chat:t1").some(item => item.kind === "unavailable")).toBe(false);
    expect(h.repo.threads.get("chat:t1")).not.toHaveProperty("evaluating");
  });
  it("clears the count of expired Evals when the gate ignores what a Thread queued", () => {
    const h = harness();
    h.engine.receive(trigger("1", { human: false }));
    h.repo.threads.save({ ...h.repo.threads.get("chat:t1")!, expired: 1 });
    h.pump();
    expect(h.repo.decisions.byThread("chat:t1")).toEqual([expect.objectContaining({ kind: "ignore" })]);
    expect(h.repo.threads.get("chat:t1")).not.toHaveProperty("expired");
  });
});

describe("final review: Policy transitions", () => {
  it("tells a worker of each Policy change that bears on its ticket, also of one that repeats an earlier transition", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const effect = { requesterAllowed: false as const };
    for (const [from, to] of [
      ["A", "B"],
      ["B", "A"],
      ["A", "B"],
    ]) {
      h.tick(1);
      h.engine.policyChanged(from!, to!, new Map([[ticketId, effect]]));
    }
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === "policy-changed")).toHaveLength(3);
  });
});
