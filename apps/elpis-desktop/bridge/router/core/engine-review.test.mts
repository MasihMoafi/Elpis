import { describe, it } from "node:test";
import { expect } from "expect";
import { UserError, runningAssignment } from "./index.mts";
import { guest, trigger, harness, accepted } from "./engine.fixtures.mts";

describe("final review: Threads followed for context", () => {
  it("lets a worker acknowledge or ask no one on a Thread it follows only for context", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.followForContext(ticketId, { source: "chat", id: "side" });
    h.tick(1);
    h.engine.receive(
      trigger("5", {
        threads: [{ source: "chat", id: "side" }],
        channel: { source: "chat", thread: "side", address: { message: "5" } },
      }),
    );
    expect(() => h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "5", text: "On it" })).toThrow(
      new UserError("notReached"),
    );
    expect(() =>
      h.engine.report(ticketId, { state: "progress", summary: "A question", question: "Which page?", askedBy: "5" }),
    ).toThrow(new UserError("notAsker"));
  });
});

describe("final review: close times", () => {
  it("records a Source's close time in the canonical form, and keeps the ticket's updatedAt moving forward", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-1" }, true);
    h.tick(30);
    const before = h.repo.tickets.get(ticketId)!.updatedAt;
    // GitHub gives whole seconds, and the PR merged before the ticket's last change.
    h.engine.threadClosed({ source: "gh", id: "pr-1" }, "merged", "2026-09-23T00:00:05Z");
    const ended = h.repo.tickets.get(ticketId)!;
    expect(ended.ended).toMatchObject({ at: "2026-09-23T00:00:05.000Z", outcome: "merged" });
    expect(ended.follows).toEqual([
      { thread: "gh:pr-1", own: true, closed: { at: "2026-09-23T00:00:05.000Z", outcome: "merged" } },
    ]);
    expect(ended.updatedAt >= before).toBe(true);
  });
});

describe("model-surface review", () => {
  it("resumes an ended ticket only on a person's message, not on a bot's that is attached to it", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "ready", summary: "Done" });
    h.tick(1);
    h.engine.receive(
      trigger("2", { human: false, actor: { source: "chat", id: "ci" }, threads: [{ source: "chat", id: "ci" }] }),
    );
    h.engine.attach(ticketId, "2");
    expect(h.repo.tickets.get(ticketId)!.ended).toBeDefined();
    // A person's message resumes it, with what waited.
    h.tick(1);
    h.engine.receive(trigger("3"));
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined();
  });
});

describe("follow-up review: turn ends", () => {
  const merge = (h: ReturnType<typeof harness>) =>
    h.engine.threadClosed({ source: "gh", id: "pr-9" }, "merged", "2026-09-23T00:00:01Z");
  it("lets a merge send to Eval only the messages its worker had no turn to read after its ready report", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-9" }, true);
    h.engine.report(ticketId, { state: "ready", summary: "PR ready" });
    // A person thanks the worker, which reads it in a turn and leaves it; another message comes after that turn.
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.read(ticketId);
    h.tick(1);
    h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id);
    h.tick(1);
    h.engine.receive(trigger("3"));
    h.settle();
    merge(h);
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["3"]);
  });
  it("keeps a ticket open at a merge while its worker works on a message it took up, also after a progress report", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-9" }, true);
    h.engine.report(ticketId, { state: "ready", summary: "PR ready" });
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "2", text: "On it" });
    // It answers another question in a progress report while it works on the message.
    h.tick(1);
    h.engine.report(ticketId, { state: "progress", summary: "Answered the other question" });
    merge(h);
    expect(h.repo.tickets.get(ticketId)!.ended).toBeUndefined();
  });
  it("ends a ticket whose close it deferred as the close did when its worker then drops the work", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-9" }, true);
    h.engine.report(ticketId, { state: "ready", summary: "PR ready" });
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.engine.reply({ purpose: "acknowledgement", ticketId, triggerId: "2", text: "On it" });
    merge(h);
    h.engine.report(ticketId, { state: "dropped", summary: "Nothing more to do" });
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ outcome: "merged" });
  });
  it("sends a message another ticket handed back to Eval when a stop on it ends the ticket that kept it", () => {
    const h = harness();
    const first = accepted(h).ticketId!;
    const second = accepted(h, "2", "t2").ticketId!;
    h.engine.bindThread(second, { source: "chat", id: "t1" }, false);
    h.engine.receive(trigger("3"));
    h.settle();
    expect(h.engine.handback(second, "3", "It is about the first fix")).toBe(false);
    h.engine.decide("3", { kind: "stop", ticketId: first, reason: "asked to stop" });
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["3"]);
  });
  it("gives a live ticket's worker again a message it had that a person sent to Eval and the main Session attached back", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.tick(1);
    h.engine.report(ticketId, { state: "progress", summary: "working" });
    h.engine.reevaluate("2");
    h.pump();
    h.engine.attach(ticketId, "2");
    expect(
      h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === "trigger" && input.triggerId === "2"),
    ).toHaveLength(2);
  });
});

describe("follow-up review: turn ends and deliveries", () => {
  it("lets a stop send to Eval a message that waited for delivery when a turn ended, and reached the worker after", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "progress", summary: "working" });
    h.tick(1);
    h.engine.receive(trigger("2"));
    const ticket = () => h.repo.tickets.get(ticketId)!,
      assignmentId = runningAssignment(ticket())!.id;
    const [inputId] = ticket().undelivered;
    // The turn ends while the message is on its way; it reaches the worker after, and a person stops the ticket in that turn.
    h.tick(1);
    h.engine.turnEnded(ticketId, assignmentId);
    h.tick(1);
    h.engine.inputsDelivered(ticketId, assignmentId, [inputId!]);
    h.tick(1);
    h.engine.stopTicket(ticketId, "not needed");
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["2"]);
  });
});

describe("follow-up review: delivery times", () => {
  it("lets a stop send to Eval a message that came before the worker's waiting report but reached the worker after it", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.tick(1);
    h.engine.receive(trigger("2"));
    const ticket = () => h.repo.tickets.get(ticketId)!,
      assignmentId = runningAssignment(ticket())!.id;
    const [inputId] = ticket().undelivered;
    // The Executor reports the worker waiting while the message is on its way; it reaches the worker after, and a person stops.
    h.tick(1);
    h.engine.report(ticketId, { state: "waiting", summary: "Waiting for input" });
    h.tick(1);
    h.engine.inputsDelivered(ticketId, assignmentId, [inputId!]);
    h.tick(1);
    h.engine.stopTicket(ticketId, "not needed");
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["2"]);
  });
});

describe("routing review", () => {
  it("records two stops of one follow-up that reached two tickets, made in the same moment, as two Decisions", () => {
    const h = harness();
    const first = accepted(h).ticketId!;
    const second = accepted(h, "2", "t2").ticketId!;
    h.engine.bindThread(second, { source: "chat", id: "t1" }, false);
    h.engine.receive(trigger("3"));
    h.settle();
    const stops = [first, second].map(ticketId =>
      h.engine.decide("3", { kind: "stop", ticketId, reason: "asked to stop" }),
    );
    expect(new Set(stops.map(stop => stop.id)).size).toBe(2);
    expect(stops.map(stop => h.repo.decisions.get(stop.id)?.ticketId)).toEqual([first, second]);
    expect([first, second].map(id => h.repo.tickets.get(id)!.ended?.outcome)).toEqual(["stopped", "stopped"]);
  });
});

describe("what a worker read", () => {
  /** A ticket that ended, resumed by a person's message `2`, whose new Assignment started; its Inputs wait for delivery. */
  function resumed() {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.report(ticketId, { state: "ready", summary: "done" });
    h.tick(1);
    h.engine.receive(trigger("2"));
    const assignmentId = h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id;
    h.tick(1);
    h.engine.assignmentStarted(ticketId, assignmentId);
    const [note, message] = h.repo.tickets.get(ticketId)!.undelivered as [string, string];
    return { h, ticketId, assignmentId, note, message, pending: () => h.repo.threads.get("chat:t1")!.pending };
  }
  it("sends to Eval a message that woke a ticket and reached its worker only after a progress report, at a dropped report", () => {
    const { h, ticketId, assignmentId, note, message, pending } = resumed();
    // Delivering the message fails at first; the worker reports progress, and the retry hands the message over while it
    // writes that nothing is left.
    h.engine.inputsDelivered(ticketId, assignmentId, [note]);
    h.engine.deliveryFailed(ticketId, assignmentId, "Session busy");
    h.tick(1);
    h.engine.report(ticketId, { state: "progress", summary: "Looking" });
    h.tick(1);
    h.engine.inputsDelivered(ticketId, assignmentId, [message]);
    h.tick(1);
    h.engine.report(ticketId, { state: "dropped", summary: "Nothing to do" });
    expect(pending()).toEqual(["2"]);
  });
  it("counts a message that woke a ticket as read by a later dropped report once its worker's Session took it into a step", () => {
    const { h, ticketId, assignmentId, note, message, pending } = resumed();
    // The Session takes it into the step its arrival starts, before the Executor records the delivery.
    h.engine.inputsRead(ticketId, [message]);
    h.engine.inputsDelivered(ticketId, assignmentId, [note, message]);
    h.tick(1);
    h.engine.report(ticketId, { state: "progress", summary: "Looking" });
    h.tick(1);
    h.engine.report(ticketId, { state: "dropped", summary: "Nothing to do" });
    expect(pending()).toEqual([]);
  });
  it("sends to Eval at a merge a message that reached the worker after its last step, which no step took before its turn ended", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.engine.bindThread(ticketId, { source: "gh", id: "pr-9" }, true);
    h.engine.report(ticketId, { state: "ready", summary: "PR ready" });
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.tick(1);
    h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id);
    h.engine.threadClosed({ source: "gh", id: "pr-9" }, "merged", "2026-09-23T00:00:01Z");
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["2"]);
  });
  it("counts a message a retry delivered after a failure and a turn end as read by a dropped report only once a step took it", () => {
    for (const taken of [false, true]) {
      const { h, ticketId, assignmentId, note, message, pending } = resumed();
      h.engine.inputsDelivered(ticketId, assignmentId, [note]);
      h.engine.deliveryFailed(ticketId, assignmentId, "Session busy");
      h.tick(1);
      h.engine.turnEnded(ticketId, assignmentId);
      h.tick(1);
      h.engine.inputsDelivered(ticketId, assignmentId, [message]);
      if (taken) h.read(ticketId);
      h.tick(1);
      h.engine.report(ticketId, { state: "dropped", summary: "Nothing to do" });
      expect(pending()).toEqual(taken ? [] : ["2"]);
    }
  });
  it("counts a message a step took before a restart cut its turn off as read only once the restarted worker reports", () => {
    for (const reported of [false, true]) {
      const h = harness();
      const ticketId = accepted(h).ticketId!;
      h.engine.report(ticketId, { state: "progress", summary: "working" });
      h.tick(1);
      h.engine.receive(trigger("2"));
      h.settle();
      h.read(ticketId);
      // The Assignment starts again with a recovery note, in the same Session, which holds the message.
      h.tick(1);
      h.engine.assignmentInterrupted(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id);
      h.settle();
      if (reported) {
        h.tick(1);
        h.engine.report(ticketId, { state: "progress", summary: "Recovered" });
      }
      h.tick(1);
      h.engine.stopTicket(ticketId, "not needed");
      expect(h.repo.threads.get("chat:t1")!.pending).toEqual(reported ? [] : ["2"]);
    }
  });
});

describe("read claims review", () => {
  it("gives a retry's Assignment the messages the failed one had delivered but no step of its worker took", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    const ticket = () => h.repo.tickets.get(ticketId)!;
    const inputId = ticket().inputs.find(input => input.kind === "trigger" && input.triggerId === "2")!.id;
    expect(ticket().undelivered).toEqual([]);
    h.tick(1);
    h.engine.report(ticketId, { state: "failed", summary: "The turn broke." });
    h.tick(1);
    h.engine.retryTicket(ticketId);
    expect(ticket().undelivered).toEqual([inputId]);
  });
});

describe("read claims review: retries", () => {
  it("gives a retry only what the Assignment it replaces had delivered and no step took, not what an earlier end let go of", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const ticket = () => h.repo.tickets.get(ticketId)!;
    const inputOf = (triggerId: string) =>
      ticket().inputs.find(input => input.kind === "trigger" && input.triggerId === triggerId)!.id;
    // A follow-up reaches the worker, and the ticket ends before any step took it, which sends it to Eval.
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    h.tick(1);
    h.engine.report(ticketId, { state: "dropped", summary: "nothing to do" });
    expect(h.repo.threads.get("chat:t1")!.pending).toEqual(["2"]);
    // A person's message resumes the ticket; its worker reports blocked before a step took the message, and a person retries.
    h.tick(1);
    h.engine.receive(trigger("3"));
    h.settle();
    h.tick(1);
    h.engine.report(ticketId, { state: "blocked", summary: "Which page?" });
    h.tick(1);
    h.engine.retryTicket(ticketId);
    expect(ticket().undelivered).toEqual([inputOf("3")]);
  });
});

describe("read claims review: restarts", () => {
  it("gives a restart's Assignment what the replaced one had delivered and no step took, and a retry of it gets it again", () => {
    const h = harness();
    const ticketId = accepted(h).ticketId!;
    const ticket = () => h.repo.tickets.get(ticketId)!;
    const inputOf = (triggerId: string) =>
      ticket().inputs.find(input => input.kind === "trigger" && input.triggerId === triggerId)!.id;
    h.tick(1);
    h.engine.receive(trigger("2"));
    h.settle();
    // The host restarts mid-work before a step took the message, which a cancel may have dropped: the new Assignment gets it.
    h.tick(1);
    h.engine.assignmentInterrupted(ticketId, runningAssignment(ticket())!.id);
    expect(ticket().undelivered[0]).toBe(inputOf("2"));
    h.settle();
    // That Assignment blocks before a step took it, and a person retries: the retry's Assignment gets it too.
    h.tick(1);
    h.engine.report(ticketId, { state: "blocked", summary: "Which page?" });
    h.tick(1);
    h.engine.retryTicket(ticketId);
    expect(ticket().undelivered).toEqual([inputOf("2")]);
  });
});

describe("ignores from the card", () => {
  const said = (text: string) => ({ code: "said", values: { text } });
  it("marks the ignore of an inferred candidate that no assessment judged, unlike an assessed one or an explicit candidate's", () => {
    const h = harness();
    accepted(h);
    // A guest's message sent to Eval is an inferred candidate, which the main Session ignores from its card.
    h.engine.receive(trigger("2", { actor: guest }));
    h.engine.reevaluate("2");
    h.pump();
    expect(h.requests.at(-1)).toMatchObject({ strength: "inferred" });
    expect(h.engine.decide("2", { kind: "ignore", reason: "Plain chat." }).reason).toEqual([
      { code: "ignoredFromCard" },
      said("Plain chat."),
    ]);
    // An assessment's ignore keeps its rule judgments, without the mark.
    h.engine.receive(trigger("3", { actor: guest }));
    h.engine.reevaluate("3");
    h.pump();
    expect(
      h.decide(h.requests.at(-1)!, { kind: "ignore", reason: "Plain chat.", audit: { rule_assessments: [] } }),
    ).toMatchObject({ reason: [said("Plain chat.")], audit: { rule_assessments: [] } });
    // An explicit candidate is always routed from its card.
    h.engine.receive(trigger("4", { threads: [{ source: "chat", id: "t9" }] }));
    h.pump();
    expect(h.engine.decide("4", { kind: "ignore", reason: "Thanks." }).reason).toEqual([said("Thanks.")]);
    // Accepting an inferred candidate still takes an assessment's matched rules.
    h.engine.receive(trigger("5", { actor: guest }));
    h.engine.reevaluate("5");
    h.pump();
    expect(() => h.engine.decide("5", { kind: "accept", title: "Fix", scope: "small", reason: "chat" })).toThrow(
      new UserError("notExplicit"),
    );
  });
});
