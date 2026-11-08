import { describe, it } from "node:test";
import { expect } from "expect";
import { UserError, waitsForPerson } from "./index.mts";
import { guest, trigger, harness, accepted } from "./engine.fixtures.mts";

describe("follow-ups", () => {
  it("takes a follow-up an older version queued out of the queue without a Decision, and keeps one sent to Eval again", () => {
    const h = harness();
    accepted(h);
    h.engine.receive(trigger("2", { actor: guest }));
    h.engine.receive(trigger("3", { actor: guest }));
    // As an older version left them: both queued for Eval; a person sent the second there again.
    const thread = h.repo.threads.get("chat:t1")!;
    h.repo.threads.save({ ...thread, pending: ["2", "3"] });
    h.engine.reevaluate("3");
    h.pump();
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(["3"]);
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual([]);
    expect(h.repo.decisions.byThread("chat:t1").flatMap(decision => decision.triggerIds)).toEqual(["1"]);
  });
  it("decides a follow-up in a gate-only Eval beside the Eval its Thread has in progress, which goes on", () => {
    const h = harness();
    const decision = accepted(h);
    h.engine.receive(trigger("2", { actor: guest }));
    h.engine.reevaluate("2");
    h.pump();
    const evaluating = h.repo.threads.get("chat:t1")!.evaluating!;
    h.engine.receive(trigger("3"));
    expect(h.engine.decide("3", { kind: "stop", ticketId: decision.ticketId!, reason: "stop it" })).toMatchObject({
      kind: "stop",
      triggerIds: ["3"],
    });
    expect(h.repo.threads.get("chat:t1")!.evaluating).toEqual(evaluating);
    expect(h.decide(h.requests.at(-1)!, { kind: "ignore", reason: "chat" })).toMatchObject({
      kind: "ignore",
      triggerIds: ["2"],
    });
  });
  it("leaves the Thread free for a later request that reaches no ticket", () => {
    const h = harness();
    const decision = accepted(h);
    h.engine.receive(trigger("2", { actor: guest }));
    h.pump();
    h.engine.stopTicket(decision.ticketId!, "not needed");
    // The follow-up held no Eval while the ticket decided it, so the next request is assessed at once rather than after a
    // timeout, together with the follow-up, which the stop let go of before its worker took it up.
    h.engine.receive(trigger("3"));
    h.pump();
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(["2", "3"]);
  });
});

describe("hand-back", () => {
  it("queues a message that reached a ticket for a fresh Eval with the gate's strength, once per ticket, and keeps the subscription", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.receive(trigger("2"));
    h.engine.receive(trigger("3", { actor: guest }));
    h.pump();
    expect(h.engine.handback(ticketId, "2", "A new request")).toBe(true);
    h.pump();
    expect(h.requests.at(-1)).toMatchObject({ strength: "explicit", triggers: [{ id: "2" }] });
    expect(h.repo.triggers.disposition("2")!.handbacks).toEqual([
      { ticketId, reason: "A new request", at: expect.any(String) },
    ]);
    h.decide(h.requests.at(-1)!, { kind: "ignore", reason: "chat" });
    expect(() => h.engine.handback(ticketId, "2", "Again")).toThrow(new UserError("handedBack"));
    expect(h.engine.handback(ticketId, "3", "A guest asks for more")).toBe(true);
    h.pump();
    expect(h.requests.at(-1)).toMatchObject({ strength: "inferred", triggers: [{ id: "3" }] });
    expect(h.repo.threads.get("chat:t1")!.subscriptions).toContain(ticketId);
    // Only a message that reached the ticket can go back.
    h.engine.receive(trigger("4", { threads: [{ source: "chat", id: "elsewhere" }] }));
    expect(() => h.engine.handback(ticketId, "4", "Not mine")).toThrow(new UserError("notReached"));
  });
  it("queues again no message the ticket did not decide: one a person sent to Eval, a bot's, or one on a Thread followed for context", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.followForContext(ticketId, { source: "chat", id: "issue" });
    h.engine.receive(trigger("2"));
    h.engine.reevaluate("2");
    h.engine.receive(trigger("3", { human: false }));
    h.engine.receive(trigger("4", { threads: [{ source: "chat", id: "issue" }] }));
    h.pump();
    for (const candidate of h.requests.slice(-2)) h.decide(candidate, { kind: "ignore", reason: "chat" });
    // Each went to Eval without the ticket, and its Decision stands.
    for (const id of ["2", "3", "4"]) expect(h.engine.handback(ticketId, id, "Not this ticket")).toBe(false);
    expect([h.repo.threads.get("chat:t1")!.pending, h.repo.threads.get("chat:issue")!.pending]).toEqual([[], []]);
    // The hand-back is recorded all the same, so the main Session does not attach the message back.
    expect(h.repo.triggers.disposition("4")!.handbacks).toEqual([
      { ticketId, reason: "Not this ticket", at: expect.any(String) },
    ]);
    expect(() => h.engine.attach(ticketId, "4")).toThrow(new UserError("handedBackHere"));
  });
  it("leaves a message the main Session attached to a ticket to its worker, whose hand-back sends it to Eval", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.receive(trigger("2", { threads: [{ source: "chat", id: "x" }] }));
    h.pump();
    h.engine.attach(ticketId, "2");
    h.settle();
    // Routed to the ticket, it is not new work as well.
    expect(() => h.engine.decide("2", { kind: "accept", title: "Y", scope: "small", reason: "requested" })).toThrow(
      new UserError("workerDecides", { tickets: ticketId }),
    );
    expect(h.engine.handback(ticketId, "2", "Asks for another change")).toBe(true);
    expect(h.repo.threads.get("chat:x")!.pending).toEqual(["2"]);
  });
});

describe("context threads and notes", () => {
  it("fans a Thread followed for context out to the live ticket, resumes no ended ticket from it, unless it was attached", async () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    expect(h.engine.followForContext(ticketId, { source: "chat", id: "issue" })).toBe(true);
    expect(h.engine.followForContext(ticketId, { source: "chat", id: "issue" })).toBe(false);
    h.engine.receive(trigger("2", { threads: [{ source: "chat", id: "issue" }] }));
    h.settle();
    expect(h.repo.tickets.get(ticketId)!.inputs.map(input => input.kind === "trigger" && input.triggerId)).toEqual([
      "2",
    ]);
    h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
    h.engine.receive(trigger("3", { threads: [{ source: "chat", id: "issue" }] }));
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined();
    // Attached by the main Session, the Thread is the ticket's own, and a person's later message there resumes it.
    h.engine.attach(ticketId, "3");
    h.settle();
    expect(h.repo.threads.get("chat:issue")).toMatchObject({ context: [] });
    h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined();
    h.engine.receive(trigger("4", { threads: [{ source: "chat", id: "issue" }] }));
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined();
  });
  it("counts a message on a Thread a ticket follows only for context as none of its follow-ups, and lifts no block with it", () => {
    const h = harness();
    const owner = accepted(h).ticketId!;
    const follower = accepted(h, "2", "other").ticketId!;
    h.engine.followForContext(follower, { source: "chat", id: "t1" });
    h.engine.receive(trigger("3", { actor: guest }));
    h.pump();
    expect(h.repo.triggers.disposition("3")).toMatchObject({ fanout: [owner, follower], context: [follower] });
    expect(h.repo.tickets.get(follower)!.inputs.at(-1)).toMatchObject({ triggerId: "3", context: true });
    // On the follower's own Thread no longer: a message reaching only it goes to Eval, with the guest's that the stopped owner
    // let go of.
    h.engine.stopTicket(owner, "done");
    h.engine.report(follower, { state: "blocked", summary: "needs a decision" });
    h.engine.receive(trigger("4"));
    h.pump();
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(["3", "4"]);
    expect(waitsForPerson(h.repo.tickets.get(follower)!)).toBe(true);
  });
  it("sends a message to Eval when the ticket it reached cannot resume and only a ticket following its Thread for context is left", () => {
    const h = harness();
    const owner = accepted(h).ticketId!;
    const follower = accepted(h, "2", "other").ticketId!;
    h.engine.followForContext(follower, { source: "chat", id: "t1" });
    h.engine.report(owner, { state: "ready", summary: "done" });
    h.setVersion("revoked");
    h.engine.receive(trigger("3"));
    h.setVersion("v1");
    h.pump();
    expect(h.repo.triggers.disposition("3")).toMatchObject({ fanout: [follower], context: [follower] });
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(["3"]);
  });
  it("gives an open ticket's worker a note as an Input of its own, held like automatic Input, and refuses one for an ended ticket", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    expect(h.engine.note(ticketId, "The other ticket renamed the API").inputs.at(-1)).toMatchObject({
      kind: "note",
      text: "The other ticket renamed the API",
    });
    // A worker that reported blocked waits for a person: a note does not wake it.
    h.settle();
    h.engine.report(ticketId, { state: "blocked", summary: "needs a decision" });
    const note = h.engine.note(ticketId, "Ticket B changed the schema").inputs.at(-1)!;
    h.settle();
    expect(h.delivered.map(([, id]) => id)).not.toContain(note.id);
    expect(h.repo.tickets.get(ticketId)!.inputs).toContainEqual(note);
    h.engine.stopTicket(ticketId, "done");
    expect(() => h.engine.note(ticketId, "Too late")).toThrow(new UserError("ticketEnded"));
  });
});
