import { describe, it } from "node:test";
import { expect } from "expect";
import { mocked } from "jest-mock";
import { UserError, followupOwners, key, runningAssignment } from "./index.mts";
import { member, guest, trigger, harness, accepted } from "./engine.fixtures.mts";

describe("follow-up owners", () => {
  const accept = { kind: "accept" as const, title: "Y", scope: "small", reason: "requested" };
  const decides = (...tickets: string[]) => new UserError("workerDecides", { tickets: tickets.join(", ") });
  it("lets the main Session take a follow-up as new work once it stopped the ticket on it", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    // "Stop this, and do Y instead": the stop ends the ticket that decided the message, so the request is the main Session's.
    h.engine.receive(trigger("2"));
    h.settle();
    expect(() => h.engine.decide("2", accept)).toThrow(decides(ticketId));
    expect(h.engine.decide("2", { kind: "stop", ticketId, reason: "asked to stop" }).kind).toBe("stop");
    // At the same moment, the accept is a Decision of its own beside the stop's.
    expect(h.engine.decide("2", accept)).toMatchObject({ kind: "accept", triggerIds: ["2"] });
    expect(
      h.repo.decisions
        .byThread("chat:t1")
        .filter(item => item.triggerIds.includes("2"))
        .map(item => item.kind),
    ).toEqual(["stop", "accept"]);
  });
  it("sends a follow-up its worker never received to Eval when the ticket ends, by a report or a stop", () => {
    for (const end of ["report", "stop"] as const) {
      const h = harness();
      const ticketId = accepted(h).ticketId!;
      h.engine.receive(trigger("2"));
      expect(h.repo.tickets.get(ticketId)!.undelivered).toHaveLength(1);
      if (end === "report") h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
      else h.engine.stopTicket(ticketId, "not needed");
      expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["2"]);
      h.pump();
      expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(["2"]);
    }
  });
  it("sends a follow-up its worker got since its last report to Eval when the ticket ends, unless it acknowledged it", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "progress", summary: "working" });
    // The worker acknowledges one of two messages, and its final report was on its way before it took up the other.
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.engine.receive(trigger("3"));
    h.settle();
    h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "2", text: "On it" });
    h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["3"]);
    // The ticket no longer counts as having reached it, so its candidate names no ticket that gave no reason.
    expect([h.repo.triggers.disposition("2")!.fanout, h.repo.triggers.disposition("3")!.fanout]).toEqual([
      [ticketId],
      [],
    ]);
  });
  it("keeps a ticket open after its pull request merged while its worker is on a person's message it took up after its last report", () => {
    for (const taken of [true, false]) {
      const h = harness();
      const ticketId = accepted(h).ticketId!;
      h.engine.bindThread(ticketId, { source: "gh", id: "pr-9" }, true);
      h.engine.report(ticketId, { state: "ready", summary: "PR ready" });
      // A person asks for one more change, which the worker takes up or has not yet, and the pull request merges meanwhile.
      h.tick(1);
      h.engine.receive(trigger("2"));
      h.settle();
      if (taken) h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "2", text: "On it" });
      h.engine.threadClosed({ source: "gh", id: "pr-9" }, "merged", "2026-09-23T00:00:01Z");
      // One it has not taken up leaves the merge to end the ticket, and goes to Eval.
      expect([h.repo.tickets.get(ticketId)!.ended?.outcome, h.repo.threads.get("chat:t1")!.pending]).toEqual(
        taken ? [undefined, []] : ["merged", ["2"]],
      );
      // The worker's ready report ends it as the pull request did.
      if (taken) h.engine.report(ticketId, { state: "ready", summary: "Done" });
      expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: "merged" });
    }
  });
  it("gives a follow-up its ended ticket let go to that ticket again when the main Session attaches it there", () => {
    for (const resumed of [false, true]) {
      const h = harness();
      const ticketId = accepted(h).ticketId!;
      // The ticket ends before its worker took up a person's message, which goes to Eval; a later message may resume it.
      h.engine.report(ticketId, { state: "progress", summary: "working" });
      h.tick(1);
      h.engine.receive(trigger("2"));
      h.settle();
      h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
      if (resumed) {
        h.tick(1);
        h.engine.receive(trigger("3"));
      }
      h.pump();
      h.tick(1);
      h.engine.attach(ticketId, "2");
      h.settle();
      // Its worker gets the message again, and an ended ticket resumes for it.
      const copies = h.repo.tickets
        .get(ticketId)!
        .inputs.filter(input => input.kind === "trigger" && input.triggerId === "2");
      expect(h.delivered).toContainEqual([ticketId, copies[1]?.id]);
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined();
      expect(followupOwners(trigger("2"), h.repo)).toEqual([ticketId]);
    }
  });
  it("wakes an ended ticket for a message attached to it that its worker read only for context or before its last report", () => {
    for (const read of ["context", "report"] as const) {
      const h = harness();
      const ticketId = accepted(h).ticketId!;
      if (read === "context") h.engine.followForContext(ticketId, { source: "chat", id: "issue" });
      h.tick(1);
      h.engine.receive(trigger("2", { threads: [{ source: "chat", id: read === "context" ? "issue" : "t1" }] }));
      h.settle();
      // The worker reports after reading it and drops the ticket; a person sends a follow-up it had to Eval from the panel.
      h.tick(1);
      h.engine.report(ticketId, { state: "progress", summary: "read it" });
      h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
      if (read === "report") h.engine.reevaluate("2");
      h.pump();
      h.tick(1);
      h.engine.attach(ticketId, "2");
      h.settle();
      expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined();
      expect(followupOwners(h.repo.triggers.get("2")!, h.repo)).toEqual([ticketId]);
    }
  });
  it("counts a question the final report answers as taken up, so it does not come back as a candidate beside its answer", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.engine.report(ticketId, { state: "ready", summary: "It reads the config.", answers: "2" });
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual([]);
    expect(h.repo.triggers.disposition("2")).toMatchObject({ fanout: [ticketId], acked: [ticketId] });
  });
  it("sends to Eval a message attached after its Eval was unavailable, once its ticket ends without taking it up", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.receive(trigger("2", { threads: [{ source: "chat", id: "x" }] }));
    h.pump();
    h.decide(h.requests.at(-1)!, { kind: "unavailable", reason: "model down" });
    h.tick(1);
    h.engine.attach(ticketId, "2");
    h.settle();
    h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
    expect(h.repo.threads.get("chat:x")!.pending).toEqual(["2"]);
  });
  it("counts an acknowledgement an earlier version queued without recording it on the message as taking the message up", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "progress", summary: "working" });
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.outbox.push({
      id: key("ack", "2"),
      channel: trigger("2").channel!,
      text: "On it",
      kind: "acknowledgement",
      ticketId,
    });
    h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
    expect([h.repo.threads.get("chat:t1")!.pending, h.repo.triggers.disposition("2")!.fanout]).toEqual([
      [],
      [ticketId],
    ]);
  });
  it("counts a message that resumed a ticket as taken up by the report that ends it again, unlike one that came later", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "ready", summary: "done" });
    // A person's thanks resumes the ticket, and its worker takes it into a step first, a moment after its Assignment started,
    // as the Executor delivers it; a request comes while it reports that nothing is left.
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.tick(1);
    h.engine.assignmentStarted(ticketId, h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id);
    h.tick(1);
    h.settle();
    h.read(ticketId);
    h.tick(1);
    h.engine.receive(trigger("3"));
    h.settle();
    h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["3"]);
  });
  it("sends a follow-up its ticket let go to Eval after a stop on it was refused, but not the one a stop ended it on", () => {
    // A guest's stop is refused, and the worker drops the ticket; a member's stop ends it, and the main Session, which stopped
    // it, decides the rest of the message itself.
    for (const actor of [guest, member]) {
      const h = harness();
      const ticketId = accepted(h).ticketId!;
      h.engine.receive(trigger("2", { actor }));
      h.engine.decide("2", { kind: "stop", ticketId, reason: "asked to stop" });
      if (actor === guest) h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
      expect(h.repo.threads.get("chat:t1")!.pending).toEqual(actor === guest ? ["2"] : []);
    }
  });
  it("sends the message a stop ended a ticket on to Eval once another ticket it reached ends without taking it up", () => {
    const h = harness();
    const stopped = accepted(h).ticketId!,
      other = accepted(h, "5", "t5").ticketId!;
    h.engine.bindThread(other, { source: "chat", id: "t1" }, false);
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.engine.decide("2", { kind: "stop", ticketId: stopped, reason: "asked to stop" });
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual([]);
    h.engine.report(other, { state: "dropped", summary: "nothing to do" });
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["2"]);
  });
  it("hands the follow-ups on a thread a worker found unrelated back to Eval, with its reason", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const elsewhere = { threads: [{ source: "chat", id: "x" }] };
    h.engine.receive(trigger("2", elsewhere));
    h.pump();
    h.engine.attach(ticketId, "2");
    h.settle();
    h.engine.receive(trigger("3", elsewhere));
    h.settle();
    expect(() => h.engine.decide("3", accept)).toThrow(decides(ticketId));
    // The worker finds the attached thread is not its ticket's, and answers nothing there: the message the main Session
    // attached goes back with the later one, and each candidate says why.
    h.engine.markUnrelated(ticketId, "chat:x", "about something else");
    expect(h.repo.threads.get("chat:x")!.pending).toEqual(["2", "3"]);
    expect(h.repo.triggers.disposition("3")!.handbacks).toEqual([
      { ticketId, reason: "about something else", at: expect.any(String) },
    ]);
    h.pump();
    expect(h.requests.at(-1)!.triggers.map(item => item.id)).toEqual(["2", "3"]);
  });
  it("keeps a follow-up two tickets reached with the one that did not hand it back, and queues it once neither decides it", () => {
    const h = harness();
    const first = accepted(h).ticketId!;
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.engine.handback(first, "2", "another change");
    h.pump();
    const second = h.decide(h.requests.at(-1)!, accept).ticketId!;
    h.settle();
    h.tick(1);
    h.engine.receive(trigger("3"));
    h.settle();
    expect(h.repo.triggers.disposition("3")!.fanout).toEqual([first, second]);
    expect(h.engine.handback(first, "3", "for the other ticket")).toBe(false);
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual([]);
    // The main Session may neither take nor dismiss it while the second ticket's worker decides it.
    expect(() => h.engine.decide("3", accept)).toThrow(decides(second));
    expect(() => h.engine.decide("3", { kind: "ignore", reason: "chat" })).toThrow(decides(second));
    expect(h.engine.handback(second, "3", "neither ticket")).toBe(true);
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["3"]);
  });
  it("lets an Eval an earlier version started on a follow-up decide it", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.receive(trigger("2"));
    h.settle();
    const thread = h.repo.threads.get("chat:t1")!;
    h.repo.threads.save({
      ...thread,
      evaluating: {
        id: "e-legacy",
        threadKey: "chat:t1",
        triggerIds: ["2"],
        strength: "explicit",
        actor: member,
        basis: { via: "listed" },
        policyVersion: "v1",
        startedAt: "2026-09-23T00:00:00Z",
        deadline: "2026-09-24T00:00:00Z",
      },
    });
    expect(followupOwners(trigger("2"), h.repo)).toEqual([]);
    expect(h.engine.decide("2", { kind: "ignore", reason: "chat", evalId: "e-legacy" })).toMatchObject({
      kind: "ignore",
      triggerIds: ["2"],
    });
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined();
  });
});

describe("interrupted assignments", () => {
  it("starts an Assignment interrupted mid-work again with a note, and hands one that waits what waits for it", () => {
    const h = harness();
    const interrupted = accepted(h).ticketId!;
    const first = h.repo.tickets.get(interrupted)!.assignments[0]!;
    const waiting = accepted(h, "2", "t2").ticketId!;
    h.engine.report(waiting, { state: "waiting", summary: "done for now" });
    h.engine.receive(trigger("3", { threads: [{ source: "chat", id: "t2" }] }));
    mocked(h.executor.start).mockClear();
    mocked(h.executor.deliver).mockClear();
    // The Executor reports each Assignment that was running; a fact about one that no longer runs is dropped.
    for (const id of [interrupted, waiting])
      h.engine.assignmentInterrupted(id, runningAssignment(h.repo.tickets.get(id)!)!.id);
    h.engine.assignmentInterrupted(interrupted, first.id);
    const ticket = h.repo.tickets.get(interrupted)!;
    expect(ticket.assignments).toEqual([
      expect.objectContaining({ id: first.id, state: "ended", endedReason: "hostRestarted" }),
      expect.objectContaining({ state: "pending" }),
    ]);
    expect(ticket.inputs).toEqual([
      expect.objectContaining({ kind: "text", text: expect.stringContaining("The host restarted") }),
    ]);
    expect(ticket.undelivered).toEqual([ticket.inputs[0]!.id]);
    expect(h.executor.start).toHaveBeenCalledTimes(1);
    expect(h.executor.start).toHaveBeenCalledWith(expect.objectContaining({ id: interrupted }), ticket.assignments[1]!);
    // A worker that waits keeps its Session and gets what waits for it.
    expect(h.repo.tickets.get(waiting)!.assignments).toHaveLength(1);
    expect(h.executor.deliver).toHaveBeenCalledTimes(1);
    expect(h.executor.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: waiting }),
      expect.objectContaining({ state: "running" }),
    );
  });
  it("starts again a worker that reported but then got a person's message, which it was working on", () => {
    const h = harness();
    const other = accepted(h, "2", "t2").ticketId!;
    h.engine.report(other, { state: "waiting", summary: "done for now" });
    h.tick(1);
    h.engine.receive(trigger("3", { actor: guest, threads: [{ source: "chat", id: "t2" }] }));
    h.settle();
    const running = runningAssignment(h.repo.tickets.get(other)!)!;
    expect(running.deliveredAt! > running.report!.at).toBe(true);
    h.engine.assignmentInterrupted(other, running.id);
    expect(h.repo.tickets.get(other)!.assignments.map(item => item.state)).toEqual(["ended", "pending"]);
  });
});

describe("pause", () => {
  it("lets no Eval expire while processing is paused, and moves its deadline on by the pause's length", () => {
    const h = harness();
    h.engine.receive(trigger("1"));
    h.pump();
    h.engine.candidateDelivered(h.requests[0]!.evalId);
    const deadline = Date.parse(h.repo.threads.get("chat:t1")!.evaluating!.deadline);
    h.tick(30);
    h.setPaused(true);
    h.pump();
    // Paused past the deadline, the Eval waits.
    h.tick(300);
    h.pump();
    expect(h.engine.candidate("1")).toBeDefined();
    h.setPaused(false);
    h.pump();
    expect(Date.parse(h.repo.threads.get("chat:t1")!.evaluating!.deadline)).toBe(deadline + 300_000);
    h.tick(29);
    h.pump();
    expect(h.engine.candidate("1")).toBeDefined();
    // Expired, it queues the Trigger again for a fresh Eval.
    h.tick(1);
    h.pump();
    expect(h.engine.candidate("1")?.evalId).not.toBe(h.requests[0]!.evalId);
    expect(h.repo.decisions.byThread("chat:t1")).toEqual([]);
  });
});

describe("policy change", () => {
  it("tells only the live tickets a change bears on how it does, and restarts in-flight evals under the new version", async () => {
    const h = harness();
    const decision = accepted(h);
    const other = accepted(h, "3", "t3").ticketId!;
    h.engine.receive(trigger("2", { threads: [{ source: "chat", id: "t2" }] }));
    h.pump();
    const effect = {
      rules: [{ id: "copy", name: "Copy", change: "changed" as const, instruction: "Fix typos only." }],
    };
    h.setVersion("v2");
    h.engine.policyChanged("v1", "v2", new Map([[decision.ticketId!, effect]]));
    expect(h.repo.tickets.get(decision.ticketId!)!.inputs).toEqual([
      expect.objectContaining({ kind: "policy-changed", from: "v1", to: "v2", effect }),
    ]);
    expect(h.repo.tickets.get(other)!.inputs.filter(input => input.kind === "policy-changed")).toEqual([]);
    expect(h.repo.decisions.byThread("chat:t2")).toEqual([
      expect.objectContaining({ kind: "unavailable", reason: [{ code: "policyChanged" }] }),
    ]);
    expect(h.repo.threads.get("chat:t2")?.pending).toEqual(["2"]);
    h.pump();
    expect(h.requests.at(-1)).toMatchObject({ policyVersion: "v2", triggers: [expect.objectContaining({ id: "2" })] });
    const told = h.repo.tickets.get(decision.ticketId!)!.inputs.find(input => input.kind === "policy-changed")!;
    expect(h.delivered).toEqual([[decision.ticketId, told.id]]);
  });
  it("does not start evals while paused", async () => {
    const h = harness({ paused: true });
    h.engine.receive(trigger("1"));
    h.pump();
    expect(h.assessor.request).not.toHaveBeenCalled();
  });
});
