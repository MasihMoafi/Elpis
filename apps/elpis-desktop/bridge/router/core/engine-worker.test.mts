import { describe, it } from "node:test";
import { expect } from "expect";
import { mocked } from "jest-mock";
import { UserError, followupOwners, key, ticketOutcome, ticketStage, waitsForPerson } from "./index.mts";
import { guest, trigger, harness, accepted } from "./engine.fixtures.mts";

describe("worker reports", () => {
  it("asks, keeps, replaces and clears the question for a person, and says which question a report replaced", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const asked = h.engine.report(ticketId, {
      state: "progress",
      summary: "need a call",
      question: "Which color?",
      askedBy: "1",
    });
    expect(asked.attention).toMatchObject({ question: "Which color?", triggerId: "1" });
    expect(h.engine.report(ticketId, { state: "blocked", summary: "still waiting" }).attention).toEqual(
      asked.attention,
    );
    expect(h.withdrawn).toEqual([]);
    const replaced = h.engine.report(ticketId, {
      state: "progress",
      summary: "other question",
      question: "Which size?",
    });
    expect(replaced.attention).toMatchObject({ question: "Which size?" });
    expect(replaced.attention).not.toHaveProperty("triggerId");
    // The replaced question is withdrawn from the outbox if its message has not gone out yet.
    expect(h.withdrawn).toEqual([key("attention-reply", asked.attention!.id)]);
    const cleared = h.engine.report(ticketId, { state: "progress", summary: "answered", question: null });
    expect(cleared).not.toHaveProperty("attention");
    expect(h.withdrawn).toEqual([
      key("attention-reply", asked.attention!.id),
      key("attention-reply", replaced.attention!.id),
    ]);
  });
  it("ends the ticket on a final report: dropped drops it, ready completes it unless it follows a Source's Thread that is open", () => {
    const outcome = (state: "ready" | "dropped" | "failed", follows: boolean, closed = false) => {
      const h = harness();
      const ticketId = accepted(h).ticketId!;
      h.engine.report(ticketId, { state: "progress", summary: "asking", question: "Merge it?" });
      if (follows) h.engine.bindThread(ticketId, { source: "gh", id: "pr-9" }, false);
      if (follows) h.engine.bindThread(ticketId, { source: "gh", id: "pr-10" }, true);
      // Work resumed after both closed ends with its ready report, using the latest close outcome.
      if (closed) {
        h.engine.threadClosed({ source: "gh", id: "pr-9" }, "closed", "2026-09-22T00:00:00Z");
        h.engine.threadClosed({ source: "gh", id: "pr-10" }, "merged", "2026-09-22T00:00:01Z");
      }
      h.engine.report(ticketId, { state, summary: "done" });
      return h.repo.tickets.get(ticketId)!;
    };
    expect(outcome("dropped", true)).toMatchObject({ ended: { by: "executor", outcome: "dropped" } });
    expect(outcome("dropped", true).ended).not.toHaveProperty("reason");
    expect(outcome("ready", false)).toMatchObject({ ended: { outcome: "completed" } });
    expect(outcome("ready", false)).not.toHaveProperty("attention");
    expect(outcome("ready", true)).toMatchObject({
      follows: [
        { thread: "gh:pr-9", own: false },
        { thread: "gh:pr-10", own: true },
      ],
      assignments: [expect.objectContaining({ report: expect.objectContaining({ state: "ready" }) })],
    });
    expect(outcome("ready", true)).not.toHaveProperty("ended");
    expect(outcome("ready", true)).not.toHaveProperty("attention");
    expect(outcome("ready", true, true)).toMatchObject({ ended: { outcome: "merged" } });
    expect(outcome("failed", false)).toMatchObject({ attention: { question: "Merge it?" } });
    expect(outcome("failed", false)).not.toHaveProperty("ended");
  });
  it("refuses a question with a result or an answer, and questions or answers that name no person's message of the ticket", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.receive(trigger("2", { human: false, threads: [{ source: "chat", id: "t1" }] }));
    h.engine.receive(trigger("4", { threads: [{ source: "chat", id: "elsewhere" }] }));
    const report = (extra: object) => () => h.engine.report(ticketId, { state: "progress", summary: "x", ...extra });
    expect(report({ state: "ready", question: "Q?" })).toThrow(new UserError("questionWithResult"));
    expect(report({ question: "Q?", answers: "1" })).toThrow(new UserError("questionWithResult"));
    expect(report({ askedBy: "1" })).toThrow(new UserError("askerWithoutQuestion"));
    expect(report({ question: "Q?", askedBy: "2" })).toThrow(new UserError("notAsker"));
    expect(report({ answers: "4" })).toThrow(new UserError("notAnswerable"));
    expect(report({ answers: "1" })()).toMatchObject({ answers: ["1"] });
  });
  it("refuses a report on an ended ticket", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.stopTicket(ticketId);
    expect(() => h.engine.report(ticketId, { state: "progress", summary: "x" })).toThrow(new UserError("ticketEnded"));
  });
});

describe("outcomes", () => {
  it("records how a ticket ended", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.stopTicket(ticketId, "Human asked to stop");
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({
      by: "human",
      outcome: "stopped",
      reason: "Human asked to stop",
    });
    expect(ticketOutcome(h.repo.tickets.get(ticketId)!)).toBe("stopped");
    expect(ticketOutcome({})).toBeUndefined();
  });
});

describe("attach", () => {
  it("sends the routing note for a message the worker has, ends an Eval that holds only that message, and refuses a ticket a person stopped or the Policy no longer holds", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.receive(trigger("2", { actor: guest }));
    h.pump();
    expect(h.delivered.map(([, input]) => input)).toEqual([key("input", ticketId, "trigger", "2")]);
    // The follow-up reached the ticket without an Eval, and is its worker's to judge; sent to Eval again by a person, it is judged there.
    expect(h.engine.candidate("2")).toBeUndefined();
    expect(() => h.engine.attach(ticketId, "2")).toThrow(new UserError("workerDecides", { tickets: ticketId }));
    expect(h.engine.reevaluate("2")).toBe(true);
    h.pump();
    expect(h.engine.candidate("2")).toBeDefined();
    const attached = h.engine.attach(ticketId, "2", "The guest asks for the same fix");
    h.settle();
    expect(attached.inputs).toEqual([
      expect.objectContaining({ triggerId: "2" }),
      expect.objectContaining({ triggerId: "2", note: "The guest asks for the same fix" }),
    ]);
    expect(h.delivered.map(([, input]) => input)).toEqual(attached.inputs.map(input => input.id));
    expect(h.engine.candidate("2")).toBeUndefined();
    expect(h.repo.decisions.byThread("chat:t1").at(-1)).toMatchObject({
      kind: "ignore",
      reason: [{ code: "routed", values: { ticket: ticketId } }],
    });
    // A note for a message that still waits for the worker goes out with it, as for one a person sent to Eval at once.
    h.engine.receive(trigger("5", { actor: guest }));
    h.engine.reevaluate("5");
    expect(h.engine.attach(ticketId, "5", "Same fix again").inputs.at(-1)).toMatchObject({
      triggerId: "5",
      note: "Same fix again",
    });
    h.settle();
    h.engine.report(ticketId, { state: "ready", summary: "done" });
    h.setVersion("revoked");
    expect(() => h.engine.attach(ticketId, "2")).toThrow(new UserError("mandateRevoked"));
    h.setVersion("v1");
    const stopped = accepted(h, "3", "t3").ticketId!;
    h.engine.stopTicket(stopped);
    expect(() => h.engine.attach(stopped, "2")).toThrow(new UserError("ticketStopped"));
    expect(() => h.engine.attach("missing", "2")).toThrow(new UserError("unknownTicket"));
  });
  it("ends the batch Eval of a message attached to a ticket and assesses the rest again, leaving the message to that ticket", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!,
      other = accepted(h, "5", "t5").ticketId!;
    const elsewhere = { threads: [{ source: "chat", id: "x" }] };
    h.engine.receive(trigger("2", elsewhere));
    h.engine.receive(trigger("3", elsewhere));
    h.pump();
    h.engine.attach(ticketId, "3");
    h.pump();
    expect(h.repo.decisions.byThread("chat:x")).toEqual([
      expect.objectContaining({
        kind: "unavailable",
        triggerIds: ["2", "3"],
        reason: [{ code: "routed", triggerId: "3", values: { ticket: ticketId } }],
      }),
    ]);
    expect(h.engine.candidate("2")?.triggers.map(item => item.id)).toEqual(["2"]);
    expect(followupOwners(h.repo.triggers.get("3")!, h.repo)).toEqual([ticketId]);
    expect(() => h.engine.attach(other, "3")).toThrow(new UserError("workerDecides", { tickets: ticketId }));
  });
  it("names missing things apart from refusals and fills in the values", () => {
    expect([new UserError("unknownTicket").missing, new UserError("ticketEnded").missing]).toEqual([true, false]);
    expect(new UserError("notAdmissible", { reason: "not_a_member" })).toMatchObject({
      code: "notAdmissible",
      values: { reason: "not_a_member" },
      message: "Trigger is not admissible: not_a_member",
    });
  });
});

describe("direct decisions", () => {
  it("decides an explicit request no Eval holds in a direct Eval, refuses a proactive accept without matched rules, and accepts a Trigger once", () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    const decision = h.engine.decide("1", { kind: "accept", title: "Fix", scope: "small", reason: "routed" });
    expect(decision).toMatchObject({ kind: "accept", triggerIds: ["1"], strength: "explicit" });
    expect(h.repo.threads.get("chat:t1")).toMatchObject({ pending: [] });
    expect(h.repo.threads.get("chat:t1")).not.toHaveProperty("evaluating");
    expect(h.engine.decide("1", { kind: "accept", title: "Again", scope: "small", reason: "routed" })).toEqual(
      decision,
    );
    // A guest's follow-up reached that ticket without an Eval: its worker decides it, and only what the worker hands back can
    // become new work, under the gate's authority, inferred.
    h.engine.receive(trigger("2", { actor: guest }));
    h.pump();
    const ticketId = decision.ticketId!;
    expect(() =>
      h.engine.decide("2", { kind: "accept", title: "Fix", scope: "small", reason: "rule", rules: ["r1"] }),
    ).toThrow(new UserError("workerDecides", { tickets: ticketId }));
    h.engine.handback(ticketId, "2", "A different fix");
    expect(() => h.engine.decide("2", { kind: "accept", title: "Fix", scope: "small", reason: "proactive" })).toThrow(
      new UserError("notExplicit"),
    );
    expect(
      h.engine.decide("2", { kind: "accept", title: "Fix", scope: "small", reason: "rule", rules: ["r1"] }),
    ).toMatchObject({ kind: "accept", strength: "inferred" });
    expect(() => h.engine.decide("missing", { kind: "ignore", reason: "x" })).toThrow(new UserError("unknownTrigger"));
  });
  it("accepts an inferred candidate only on rules the Policy admits, whoever names them", () => {
    const h = harness({ admitsInferred: rules => rules.includes("enabled") });
    accepted(h);
    h.engine.receive(trigger("2", { actor: guest }));
    h.engine.reevaluate("2");
    h.pump();
    const candidate = h.requests.at(-1)!;
    expect(() =>
      h.decide(candidate, { kind: "accept", title: "Fix", scope: "small", reason: "rule", rules: ["disabled"] }),
    ).toThrow(new UserError("notExplicit"));
    expect(
      h.decide(candidate, { kind: "accept", title: "Fix", scope: "small", reason: "rule", rules: ["enabled"] }),
    ).toMatchObject({ kind: "accept" });
  });
  it("ends the Eval of a replayed Trigger that started a ticket, and returns that ticket's Decision for it", () => {
    const h = harness();
    const decision = accepted(h);
    h.tick(1);
    expect(h.engine.reevaluate("1")).toBe(true);
    h.pump();
    expect(h.engine.candidate("1")).toBeUndefined();
    expect(h.repo.decisions.byThread("chat:t1").at(-1)).toMatchObject({
      kind: "ignore",
      triggerIds: ["1"],
      reason: [{ code: "startedTicket", triggerId: "1", values: { ticket: decision.ticketId } }],
    });
    expect(h.engine.decide("1", { kind: "accept", title: "Fix", scope: "small", reason: "again" })).toEqual(decision);
    expect(h.repo.tickets.list()).toHaveLength(1);
    expect(() => h.engine.reevaluate("missing")).toThrow(new UserError("unknownTrigger"));
  });
  it("keeps a replayed Trigger that started a ticket out of the Eval of the Triggers queued with it", () => {
    const h = harness();
    const decision = accepted(h);
    h.engine.receive(trigger("2", { actor: guest }));
    h.engine.reevaluate("2");
    h.engine.reevaluate("1");
    h.pump();
    // The member's replayed request lends the guest's message no authority.
    expect(h.engine.candidate("1")).toBeUndefined();
    expect(h.engine.candidate("2")).toMatchObject({ strength: "inferred", triggers: [{ id: "2" }] });
    expect(() => h.engine.decide("2", { kind: "accept", title: "Other", scope: "small", reason: "routed" })).toThrow(
      new UserError("notExplicit"),
    );
    expect(h.engine.decide("1", { kind: "accept", title: "Fix", scope: "small", reason: "again" })).toEqual(decision);
    expect(h.repo.tickets.list()).toHaveLength(1);
  });
  it("starts a ticket from a request accepted beside a replayed one, with its own origin and acknowledgement", () => {
    const h = harness();
    const first = accepted(h);
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.engine.reevaluate("2");
    h.engine.reevaluate("1");
    h.pump();
    const second = h.decide(h.requests.at(-1)!, {
      kind: "accept",
      title: "Other",
      scope: "small",
      reason: "routed",
      acknowledgement: "On it",
    });
    expect(second.ticketId).not.toBe(first.ticketId);
    expect(h.repo.tickets.get(second.ticketId!)!.origin).toEqual({ triggerId: "2", triggerIds: ["2"] });
    expect(h.outbox.find(message => message.id === key("ack", "2"))).toMatchObject({
      text: "On it",
      kind: "acknowledgement",
    });
    // The replayed request still answers with the ticket it started.
    expect(h.engine.decide("1", { kind: "accept", title: "Again", scope: "small", reason: "again" })).toEqual(first);
  });
});

describe("automatic input", () => {
  it("holds back automatic Input from a worker that reported blocked or failed until a person's message arrives", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const bot = (id: string) => trigger(id, { human: false });
    h.engine.receive(bot("2"));
    h.engine.report(ticketId, { state: "blocked", summary: "needs a decision" });
    // Both pending and subsequent automated inputs stay queued on the ticket without waking the worker.
    h.engine.receive(bot("3"));
    h.settle();
    expect(h.repo.tickets.get(ticketId)).toMatchObject({
      undelivered: [],
      inputs: [expect.objectContaining({ triggerId: "2" }), expect.objectContaining({ triggerId: "3" })],
    });
    expect(h.delivered).toEqual([]);
    h.tick(1);
    h.engine.receive(trigger("4", { actor: guest }));
    h.engine.receive(bot("5"));
    h.settle();
    expect(h.delivered.map(([, input]) => input)).toEqual([
      key("input", ticketId, "trigger", "4"),
      key("input", ticketId, "trigger", "5"),
    ]);
  });
  it("stops waiting for a person on a person's message, a later report that is neither blocked nor failed, or a retry", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const ticket = () => h.repo.tickets.get(ticketId)!;
    h.engine.report(ticketId, { state: "blocked", summary: "needs a decision" });
    expect(waitsForPerson(ticket())).toBe(true);
    expect(ticketStage(ticket())).toEqual({ stage: "person", action: "blocked" });
    // The worker has the person's reply, so the stale blocked report no longer holds the ticket.
    h.tick(1);
    h.engine.receive(trigger("2", { actor: guest }));
    h.settle();
    expect(waitsForPerson(ticket())).toBe(false);
    expect(ticketStage(ticket())).toEqual({ stage: "working" });
    h.tick(1);
    h.engine.report(ticketId, { state: "failed", summary: "broke" });
    expect(waitsForPerson(ticket())).toBe(true);
    h.tick(1);
    h.engine.report(ticketId, { state: "progress", summary: "found a way" });
    expect(waitsForPerson(ticket())).toBe(false);
    h.tick(1);
    h.engine.report(ticketId, { state: "blocked", summary: "needs access" });
    h.engine.retryTicket(ticketId);
    expect(waitsForPerson(ticket())).toBe(false);
  });
  it("launches a failed launch again for a person's message, but not for a Policy change", () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    const ticketId = h.decide(h.requests.at(-1)!, {
      kind: "accept",
      title: "Fix",
      scope: "small",
      reason: "requested",
    }).ticketId!;
    h.engine.report(ticketId, { state: "failed", summary: "The prepare command failed" });
    mocked(h.executor.start).mockClear();
    h.setVersion("v2");
    h.engine.policyChanged("v1", "v2");
    expect(h.executor.start).not.toHaveBeenCalled();
    h.tick(1);
    h.engine.receive(trigger("2", { actor: guest }));
    expect(h.executor.start).toHaveBeenCalledTimes(1);
    expect(h.executor.start).toHaveBeenCalledWith(
      expect.objectContaining({ id: ticketId }),
      expect.objectContaining({ state: "pending" }),
    );
  });
});

describe("replies", () => {
  it("acknowledges a person's message that reached an open ticket once, and refuses others", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    // The acknowledgement of the accept stays; a later request for one reuses it.
    expect(h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "1", text: "On it" })).toEqual({
      id: key("ack", "1"),
      status: "pending",
      reused: true,
    });
    expect(h.outbox.map(message => message.text)).toEqual(["ok"]);
    h.engine.receive(trigger("2", { actor: guest }));
    expect(h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "2", text: "Looking" })).toEqual({
      id: key("ack", "2"),
      status: "pending",
      reused: false,
    });
    h.engine.receive(trigger("3", { human: false }));
    expect(() => h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "3", text: "x" })).toThrow(
      new UserError("ackNotPerson"),
    );
    h.engine.receive(trigger("6", { threads: [{ source: "chat", id: "elsewhere" }] }));
    expect(() => h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "6", text: "x" })).toThrow(
      new UserError("notReached"),
    );
    h.engine.stopTicket(ticketId);
    expect(() => h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "2", text: "x" })).toThrow(
      new UserError("ackEnded"),
    );
  });
  it("sends an answer only after the worker reported it, a result only for a ready ticket, and attention only for its current question", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const asked = trigger("2", { actor: guest, channel: { source: "chat", thread: "t1", address: { message: "2" } } });
    h.engine.receive(asked);
    expect(() => h.engine.reply({ purpose: "answer", triggerId: "2", text: "Yes" })).toThrow(new UserError("noAnswer"));
    h.engine.report(ticketId, { state: "progress", summary: "Yes", answers: "2" });
    expect(h.engine.reply({ purpose: "answer", triggerId: "2", text: "Yes" })).toMatchObject({
      status: "pending",
      reused: false,
    });
    expect(h.outbox.at(-1)).toMatchObject({ channel: asked.channel, text: "Yes", kind: "reply" });
    expect(h.repo.tickets.get(ticketId)!.answers).toEqual([]);
    expect(() => h.engine.reply({ purpose: "result", ticketId, text: "Done" })).toThrow(new UserError("notReady"));
    h.engine.report(ticketId, { state: "progress", summary: "asking", question: "Which color?", askedBy: "2" });
    expect(() => h.engine.reply({ purpose: "attention", ticketId, question: "Which size?", text: "x" })).toThrow(
      new UserError("notAttention"),
    );
    // Without an open question there is nothing to ask, whether or not a question is named.
    const quiet = accepted(h, "9", "t9").ticketId!;
    expect(() => h.engine.reply({ purpose: "attention", ticketId: quiet, text: "Anything to send." })).toThrow(
      new UserError("notAttention"),
    );
    expect(() =>
      h.engine.reply({ purpose: "attention", ticketId: quiet, question: "", text: "Anything to send." }),
    ).toThrow(new UserError("notAttention"));
    const attention = h.repo.tickets.get(ticketId)!.attention!;
    expect(h.engine.reply({ purpose: "attention", ticketId, question: "Which color?", text: "Which color?" }).id).toBe(
      key("attention-reply", attention.id),
    );
    // A question goes where the message that raised it was written.
    expect(h.outbox.at(-1)!.channel).toEqual(asked.channel);
    h.engine.report(ticketId, { state: "ready", summary: "Done" });
    expect(h.engine.reply({ purpose: "result", ticketId, text: "Done" })).toMatchObject({ status: "pending" });
    expect(h.outbox.at(-1)!.channel).toEqual(trigger("1").channel);
  });
});
