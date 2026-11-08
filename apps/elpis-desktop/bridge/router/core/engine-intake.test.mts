import { describe, it } from "node:test";
import { expect } from "expect";
import { UserError, key } from "./index.mts";
import { member, guest, trigger, harness, accepted } from "./engine.fixtures.mts";

describe("intake", () => {
  it("stores a trigger once and records source filtering", () => {
    const h = harness();
    expect(h.engine.receive(trigger("1"))).toBe("stored");
    expect(h.engine.receive(trigger("1"))).toBe("duplicate");
    expect(h.engine.receive(trigger("2", { meta: { blocked: true } }))).toBe("filtered");
    expect(h.repo.triggers.disposition("2")?.filtered).toEqual({ code: "chat not allowed" });
    expect(h.repo.threads.get("chat:t1")?.pending).toEqual(["1"]);
  });
  it("records correlation for a trigger on several threads and evaluates only on the primary one", () => {
    const h = harness();
    h.engine.receive(
      trigger("1", {
        threads: [
          { source: "gh", id: "pr-7" },
          { source: "gh", id: "run-9" },
        ],
      }),
    );
    expect(h.repo.threads.get("gh:pr-7")).toMatchObject({ pending: ["1"], correlated: ["gh:run-9"] });
    expect(h.repo.threads.get("gh:run-9")).toMatchObject({ pending: [], correlated: ["gh:pr-7"] });
  });
});

describe("eval", () => {
  it("ignores at the gate without an assessor when nothing is admissible", async () => {
    const h = harness();
    h.engine.receive(trigger("1", { human: false }));
    h.pump();
    expect(h.assessor.request).not.toHaveBeenCalled();
    expect(h.repo.decisions.byThread("chat:t1")).toEqual([
      expect.objectContaining({ kind: "ignore", triggerIds: ["1"] }),
    ]);
    expect(h.repo.triggers.disposition("1")?.decisionId).toBeDefined();
  });
  it("releases the assessor's state for every eval that ends, decided or not", async () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    h.decide(h.requests[0]!, { kind: "ignore", reason: "chatter" });
    expect(h.assessor.release).toHaveBeenCalledTimes(1);
    expect(h.assessor.release).toHaveBeenCalledWith(h.requests[0]!.evalId);
  });
  it("serializes evals per thread and debounces triggers that arrive meanwhile", async () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    h.engine.receive(trigger("2"));
    h.engine.receive(trigger("3"));
    h.pump();
    expect(h.requests).toHaveLength(1);
    expect(h.repo.threads.get("chat:t1")?.pending).toEqual(["2", "3"]);
    h.decide(h.requests[0]!, { kind: "ignore", reason: "chatter" });
    h.pump();
    expect(h.requests[1]!.triggers.map(t => t.id)).toEqual(["2", "3"]);
    expect(h.requests[1]!.strength).toBe("explicit");
  });
  it("accept creates a ticket with a mandate, subscribes the thread, queues the acknowledgement and starts an assignment", async () => {
    const h = harness();
    const decision = accepted(h);
    const ticket = h.repo.tickets.get(decision.ticketId!)!;
    expect(ticket).toMatchObject({
      title: "Fix",
      mandate: { strength: "explicit", policyVersion: "v1", basis: { via: "listed" }, actor: member, scope: "small" },
      channels: [trigger("1").channel],
      origin: { triggerId: "1", triggerIds: ["1"] },
    });
    expect(ticket).not.toHaveProperty("ended");
    expect(ticket.assignments).toEqual([expect.objectContaining({ state: "running", startedAt: expect.any(String) })]);
    expect(h.repo.threads.get("chat:t1")?.subscriptions).toEqual([ticket.id]);
    expect(h.outbox).toEqual([
      { id: key("ack", "1"), channel: trigger("1").channel, text: "ok", kind: "acknowledgement", ticketId: ticket.id },
    ]);
    expect(h.executor.start).toHaveBeenCalledTimes(1);
  });
  it("refuses to decide an eval that a later eval replaced, and decides the later one", async () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    const first = h.requests[0]!;
    h.setVersion("v2");
    h.engine.policyChanged("v1", "v2");
    h.pump();
    const second = h.requests[1]!;
    expect(() => h.decide(first, { kind: "ignore", reason: "chatter" })).toThrow(
      "has finished or a later eval replaced it",
    );
    expect(h.decide(second, { kind: "ignore", reason: "chatter" })).toMatchObject({
      kind: "ignore",
      evalId: second.evalId,
    });
  });
  it("records an accept with its ticket, subscriptions and acknowledgement together, or none of them", async () => {
    const h = harness(
      {},
      {
        prepareTicket: () => {
          throw new Error("No directory for the ticket");
        },
      },
    );
    h.engine.receive(trigger("1"));
    h.pump();
    const evalId = h.requests[0]!.evalId;
    expect(() =>
      h.decide(h.requests[0]!, {
        kind: "accept",
        title: "Fix",
        scope: "small",
        reason: "requested",
        acknowledgement: "ok",
      }),
    ).toThrow("No directory");
    expect(h.repo.decisions.byThread("chat:t1")).toEqual([]);
    expect(h.repo.tickets.list()).toEqual([]);
    expect(h.repo.threads.get("chat:t1")).toMatchObject({ evaluating: { id: evalId }, subscriptions: [] });
    expect(h.outbox).toEqual([]);
  });
  it("records unavailable when the policy version changed during assessment", async () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    h.setVersion("v2");
    const decision = h.decide(h.requests[0]!, { kind: "accept", title: "x", scope: "x", reason: "x" });
    expect(decision.kind).toBe("unavailable");
    expect(h.repo.tickets.list()).toEqual([]);
  });
  it("starts every pending eval in one step, so a second pump starts none of them again", () => {
    const h = harness();
    for (const [id, thread] of [
      ["1", "A"],
      ["2", "B"],
    ] as const)
      h.engine.receive(trigger(id, { threads: [{ source: "chat", id: thread }] }));
    expect(h.engine.evaluateDue()).toBeUndefined();
    h.engine.evaluateDue();
    expect(h.requests.map(candidate => candidate.thread.key)).toEqual(["chat:A", "chat:B"]);
  });
  it("counts an Eval's deadline from its delivery, queues its Triggers again twice when it expires, then records it unavailable", async () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    // A candidate the assessor's Session has not taken does not expire.
    h.tick(600);
    h.pump();
    expect(h.engine.candidate("1")?.evalId).toBe(h.requests[0]!.evalId);
    const deliver = () => {
      h.engine.candidateDelivered(h.requests.at(-1)!.evalId);
    };
    deliver();
    h.tick(59);
    h.pump();
    expect(h.requests).toHaveLength(1);
    // Expired, it records nothing and queues the Trigger for a fresh Eval, twice.
    h.tick(2);
    h.pump();
    expect(h.repo.decisions.byThread("chat:t1")).toEqual([]);
    expect(h.assessor.release).toHaveBeenCalledWith(h.requests[0]!.evalId);
    expect(h.requests.map(item => item.triggers.map(each => each.id))).toEqual([["1"], ["1"]]);
    deliver();
    h.tick(61);
    h.pump();
    expect(h.requests).toHaveLength(3);
    // The third expiry is recorded unavailable.
    deliver();
    h.tick(61);
    h.pump();
    expect(h.repo.decisions.byThread("chat:t1")).toEqual([
      expect.objectContaining({ kind: "unavailable", reason: [{ code: "timeout" }] }),
    ]);
    expect(h.repo.threads.get("chat:t1")).toMatchObject({ pending: [] });
    expect(h.repo.threads.get("chat:t1")).not.toHaveProperty("evaluating");
    expect(h.repo.threads.get("chat:t1")).not.toHaveProperty("expired");
  });
});

describe("subscription fan-out", () => {
  it("delivers a person's later message on a subscribed thread to the live ticket as context, and not to Eval", async () => {
    const h = harness();
    const decision = accepted(h);
    const requests = h.requests.length;
    h.engine.receive(trigger("2", { actor: guest }));
    h.pump();
    const ticket = h.repo.tickets.get(decision.ticketId!)!;
    expect(ticket.inputs).toEqual([expect.objectContaining({ kind: "trigger", triggerId: "2" })]);
    expect(ticket.undelivered).toEqual([]);
    expect(h.delivered).toEqual([[ticket.id, ticket.inputs[0]!.id]]);
    expect(h.repo.triggers.disposition("2")).toEqual({ fanout: [ticket.id], at: expect.any(String) });
    // No Eval, so no Decision and no timeout, and the Thread's queue stays free for a new request.
    expect([
      h.requests.length,
      h.repo.threads.get("chat:t1")!.pending,
      h.repo.decisions.byThread("chat:t1").length,
    ]).toEqual([requests, [], 1]);
    h.tick(600);
    h.engine.evaluateDue();
    expect(h.repo.decisions.byThread("chat:t1")).toHaveLength(1);
    // A bot's message there still goes to Eval, which the gate does not admit.
    h.engine.receive(trigger("3", { human: false }));
    h.pump();
    expect(h.repo.decisions.byThread("chat:t1").at(-1)).toMatchObject({ kind: "ignore", triggerIds: ["3"] });
  });
  it("keeps inputs undelivered until an assignment is running, and asks to launch one whose launch failed again", () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    const decision = h.decide(h.requests[0]!, { kind: "accept", title: "Fix", scope: "small", reason: "requested" });
    h.settle({ launch: false });
    h.engine.receive(trigger("2"));
    h.engine.evaluateDue();
    h.settle({ launch: false });
    const ticket = h.repo.tickets.get(decision.ticketId!)!;
    expect(ticket.undelivered).toHaveLength(1);
    expect(h.executor.deliver).not.toHaveBeenCalled();
    expect(h.executor.start).toHaveBeenCalledTimes(2);
    h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id);
    h.settle();
    expect(h.delivered).toEqual([[ticket.id, ticket.undelivered[0]!]]);
  });
  it("does not hand a bot's message to an ended ticket, and still assesses it", async () => {
    const h = harness();
    const decision = accepted(h);
    h.engine.report(decision.ticketId!, { state: "ready", summary: "done" });
    h.engine.receive(trigger("2", { human: false }));
    h.pump();
    // The Executor reads its threads again when it resumes, so bots and CI neither wake nor queue on an ended ticket.
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] });
    expect(h.executor.start).toHaveBeenCalledTimes(1);
  });
  it("resumes once however often it pumps, with the resume note ahead of the message, and drops what waited when the policy no longer holds the mandate", async () => {
    const h = harness();
    const decision = accepted(h);
    h.engine.report(decision.ticketId!, { state: "ready", summary: "done" });
    h.setVersion("revoked");
    h.engine.receive(trigger("2", { actor: guest }));
    h.pump();
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.anything(), undelivered: [] });
    h.setVersion("v1");
    h.pump();
    expect(h.repo.tickets.get(decision.ticketId!)!.ended).toBeDefined();
    h.engine.receive(trigger("3", { actor: guest }));
    h.pump();
    h.pump();
    const ticket = h.repo.tickets.get(decision.ticketId!)!;
    expect(ticket.assignments).toHaveLength(2);
    expect(ticket.inputs.filter(input => input.kind === "resumed")).toHaveLength(1);
  });
  it("takes delivery reports only from the assignment that still runs the open ticket", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const assignment = h.repo.tickets.get(ticketId)!.assignments[0]!.id;
    h.engine.receive(trigger("2"));
    const input = key("input", ticketId, "trigger", "2");
    h.engine.deliveryFailed(ticketId, assignment, "Session busy");
    expect(h.repo.tickets.get(ticketId)!.delivery).toMatchObject({ error: "Session busy" });
    h.engine.deliveryFailed(ticketId, "another", "other");
    h.engine.inputsDelivered(ticketId, "another", [input]);
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ undelivered: [input], delivery: { error: "Session busy" } });
    h.engine.inputsDelivered(ticketId, assignment, [input]);
    expect(h.repo.tickets.get(ticketId)!.undelivered).toEqual([]);
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty("delivery");
    h.engine.receive(trigger("3"));
    h.engine.stopTicket(ticketId);
    h.engine.deliveryFailed(ticketId, assignment, "late");
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.anything(), undelivered: [] });
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty("delivery");
  });
  it("unsubscribing a thread stops fan-out until a new decision subscribes it", async () => {
    const h = harness();
    const decision = accepted(h);
    expect(h.engine.unsubscribe("chat:t1")).toBe(true);
    h.engine.receive(trigger("2"));
    h.pump();
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([]);
  });
  it("lets an Executor drop a thread attached to its ticket, keeping the thread's other tickets, but not its own threads", async () => {
    const events: { type: string; data: Record<string, unknown> }[] = [];
    const h = harness({}, { emit: event => events.push(event) });
    const first = accepted(h).ticketId!;
    const second = accepted(h, "2", "t2").ticketId!;
    h.engine.receive(trigger("3", { threads: [{ source: "chat", id: "t2" }] }));
    // A follow-up of the second ticket goes to the first only once the second's worker hands it back.
    h.engine.handback(second, "3", "It is about the first fix");
    h.engine.attach(first, "3");
    expect(h.repo.threads.get("chat:t2")!.subscriptions).toEqual([second, first]);
    h.engine.markUnrelated(first, "chat:t2", "about another fix");
    expect(h.repo.threads.get("chat:t2")!.subscriptions).toEqual([second]);
    expect(events.filter(event => event.type === "thread.unsubscribed").map(event => event.data)).toEqual([
      { threadKey: "chat:t2", ticketId: first, by: "executor", reason: "about another fix" },
    ]);
    expect(() => h.engine.markUnrelated(first, "chat:t2", "again")).toThrow(new UserError("notFollowing"));
    expect(() => h.engine.markUnrelated(first, "chat:t1", "its own")).toThrow(new UserError("sourceThread"));
    h.engine.bindThread(first, { source: "gh", id: "pr-9" }, true);
    expect(() => h.engine.markUnrelated(first, "gh:pr-9", "its PR")).toThrow(new UserError("followedThread"));
  });
});

describe("resume and stop", () => {
  async function ended(h: ReturnType<typeof harness>, by: "executor" | "human") {
    const decision = accepted(h);
    if (by === "executor") h.engine.report(decision.ticketId!, { state: "ready", summary: "done" });
    else h.engine.stopTicket(decision.ticketId!);
    return decision.ticketId!;
  }
  it("resumes an ended ticket on any person's message on its thread, under the same mandate and without a Decision", async () => {
    const h = harness();
    const ticketId = await ended(h, "executor");
    const decisions = h.repo.decisions.byThread("chat:t1").length;
    // It resumes as the message arrives, before any Eval of it.
    h.engine.receive(trigger("2", { actor: guest }));
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined();
    h.pump();
    const ticket = h.repo.tickets.get(ticketId)!;
    expect(ticket.assignments).toHaveLength(2);
    expect(ticket.mandate.policyVersion).toBe("v1");
    expect(ticket.inputs.map(input => input.kind)).toEqual(["trigger", "resumed"]);
    expect(h.executor.start).toHaveBeenCalledTimes(2);
    // The message still reaches Eval as a follow-up, but no reopen Decision is needed or possible.
    expect(h.repo.decisions.byThread("chat:t1").filter(decision => decision.kind !== "ignore")).toHaveLength(decisions);
  });
  it("resumes an ended ticket an earlier version left with a person's message waiting, on the next pass", async () => {
    const h = harness();
    const ticketId = await ended(h, "executor");
    h.engine.receive(trigger("2", { actor: guest, threads: [{ source: "chat", id: "elsewhere" }] }));
    const stored = h.repo.tickets.get(ticketId)!;
    const input = {
      id: "waiting",
      kind: "trigger" as const,
      triggerId: "2",
      at: stored.updatedAt,
      human: true as const,
    };
    h.repo.tickets.save({ ...stored, inputs: [...stored.inputs, input], undelivered: ["waiting"] });
    h.pump();
    expect(h.repo.tickets.get(ticketId)).toMatchObject({
      inputs: expect.arrayContaining([expect.objectContaining({ kind: "resumed" })]),
    });
    expect(h.repo.tickets.get(ticketId)).not.toHaveProperty("ended");
  });
  it("resumes an ended ticket at once when a person attaches a message to it", async () => {
    const h = harness();
    const ticketId = await ended(h, "executor");
    h.engine.receive(trigger("2", { actor: guest, threads: [{ source: "chat", id: "elsewhere" }] }));
    const subject = h.engine.attach(ticketId, "2");
    expect(subject).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: "pending" })] });
    expect(subject).not.toHaveProperty("ended");
  });
  it("keeps a ticket a person stopped ended: the stop withdrew its mandate", async () => {
    const h = harness();
    const ticketId = await ended(h, "human");
    expect(h.executor.stop).toHaveBeenCalledTimes(1);
    h.engine.receive(trigger("2"));
    h.pump();
    expect(h.repo.tickets.get(ticketId)).toMatchObject({ ended: expect.objectContaining({ by: "human" }) });
    expect(h.executor.start).toHaveBeenCalledTimes(1);
  });
  it("keeps a ticket ended when its mandate no longer passes the current policy", async () => {
    const h = harness();
    const ticketId = await ended(h, "executor");
    h.setVersion("revoked");
    h.engine.receive(trigger("2"));
    h.pump();
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined();
  });
  it("stops a live ticket only on an explicit instruction and ends it by the human", async () => {
    const h = harness();
    const decision = accepted(h);
    // Follow-ups that reached the ticket: the gate judges them when the main Session acts on one, a guest's as inferred.
    h.engine.receive(trigger("2", { actor: guest }));
    h.pump();
    expect(h.engine.decide("2", { kind: "stop", ticketId: decision.ticketId!, reason: "x" })).toMatchObject({
      kind: "ignore",
      strength: "inferred",
      reason: [{ code: "stopNotExplicit" }],
    });
    h.engine.receive(trigger("3"));
    h.pump();
    expect(h.engine.decide("3", { kind: "stop", ticketId: decision.ticketId!, reason: "human said stop" }).kind).toBe(
      "stop",
    );
    expect(h.repo.tickets.get(decision.ticketId!)).toMatchObject({ ended: expect.objectContaining({ by: "human" }) });
    expect(h.executor.stop).toHaveBeenCalledTimes(1);
  });
});
