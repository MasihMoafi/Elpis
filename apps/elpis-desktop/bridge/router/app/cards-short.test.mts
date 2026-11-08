import { it } from "node:test";
import { expect } from "expect";
import { masterPrompt, workerPrompt } from "./context.mts";
import { TICKET_STATES, decisionCard, decisionDetails, ticketCard, ticketDetails, triggerCard, threadCard } from "./cards.mts";
import { key, said, type Decision, type Thread, type Ticket } from "../core/index.mts";
import { RULES, textOf, trigger, SUMMARY, ticket } from "./cards.fixtures.mts";

for (const [_rule, file, says, gone = []] of RULES)
  it(`${_rule} (${file})`, () => {
    const text = textOf(file);
    for (const words of says) expect(text).toContain(words);
    for (const words of gone) expect(text.toLowerCase()).not.toContain(words.toLowerCase());
  });

it("keeps each role's own instructions short", () => {
  expect(masterPrompt.length).toBeLessThan(1400);
  expect(workerPrompt.length).toBeLessThan(1000);
});

it("shows a trigger and a ticket as cards with a short preview and references to their bodies", () => {
  const card = triggerCard(trigger, { fanout: ["ticket-1"], evalId: "e1", decisionId: "d1", at: "" });
  expect(card).toEqual({
    trigger_id: "request-1",
    source: "github",
    actor: "alice",
    thread: "github:42",
    human: true,
    at: "2026-09-09T00:00:00Z",
    preview: expect.stringMatching(/^Please inspect the failing check\. Additional context\./),
    chars: trigger.text.length,
    read: "trigger/request-1",
    disposition: { decision_id: "d1", delivered_to: ["ticket-1"] },
  });
  expect(card.preview).toHaveLength(160);
  const { policyVersion: _version, ...mandate } = ticket.mandate;
  const threads = [{ thread: "github:42", bound: true as const }];
  const batch = [{ ...trigger, id: "request-2", text: "Also the flaky one." }];
  expect(ticketDetails(ticket, threads, batch)).toEqual({
    ticket_id: "ticket-1",
    title: "Inspect failing check",
    state: "person/review",
    strength: "explicit",
    pr_number: 42,
    read: "ticket/ticket-1",
    trigger_id: "request-1",
    decision_id: "d1",
    batch: [
      {
        trigger_id: "request-2",
        from: "alice",
        at: trigger.at,
        preview: "Also the flaky one.",
        read: "trigger/request-2",
      },
    ],
    threads,
    directory: "/worktrees/ticket-1",
    scope: mandate.scope,
    requested_by: "alice",
    inputs: { items: [] },
    assignments: {
      items: [
        {
          id: "a1",
          state: "running",
          at: "2026-09-09T00:00:00Z",
          report: {
            state: "ready",
            at: "",
            preview: expect.stringMatching(/^The focused/),
            chars: SUMMARY.length,
            read: "ticket/ticket-1/report/a1",
          },
        },
      ],
    },
    assignment: "ticket/ticket-1/assignment",
    result: "ticket/ticket-1/result",
    transcript: "ticket/ticket-1/transcript",
  });
  // Its worker reads no Decision, so it sees no Decision's id.
  expect(
    ticketDetails({ ...ticket, inputs: [{ id: "r", kind: "reopen", decisionId: "d2", at: "1" }] }, threads, [], true),
  ).toMatchObject({
    inputs: { items: [{ kind: "reopen", read: `ticket/ticket-1/input/${key("r")}` }] },
  });
  expect(
    JSON.stringify(
      ticketDetails({ ...ticket, inputs: [{ id: "r", kind: "reopen", decisionId: "d2", at: "1" }] }, threads, [], true),
    ),
  ).not.toMatch(/"d[12]"/);
  // The latest ten Inputs, newest first, each read by the name its line gives; the next page reads from the Inputs' own list.
  const inputs = Array.from({ length: 12 }, (_, n) => ({
    id: `text:${n}`,
    kind: "text" as const,
    text: `Note ${n}`,
    at: String(n),
  }));
  const page = ticketDetails(
    {
      ...ticket,
      inputs: [...inputs, { id: "text:long", kind: "text", text: "Long note. ".repeat(10), at: "12" }],
      undelivered: ["text:11"],
    },
    [],
    [],
  ).inputs;
  // A short text is inline; a longer one shows a preview and reads through the Input's resource.
  expect([page.items.length, page.items[0], page.items[1], page.next_resource, page.next_offset]).toEqual([
    10,
    {
      kind: "text",
      at: "12",
      preview: expect.stringMatching(/^Long note\./),
      chars: 110,
      read: `ticket/ticket-1/input/${key("text:long")}`,
    },
    { kind: "text", at: "11", text: "Note 11", undelivered: true },
    "ticket/ticket-1/inputs",
    10,
  ]);
});

it("shows a ticket card's state from a closed set: the open ticket's stage, the ended ticket's outcome", () => {
  const report = (state: string) =>
    ({ ...ticket, assignments: [{ ...ticket.assignments[0]!, report: { state, summary: "", at: "" } }] }) as Ticket;
  const cases: [Ticket, string][] = [
    [ticket, "person/review"],
    [report("blocked"), "person/blocked"],
    [report("failed"), "person/failed"],
    [report("waiting"), "idle"],
    [report("progress"), "working"],
    [{ ...ticket, attention: { id: "q", question: "Desktop too?" } }, "person/answer"],
    [{ ...ticket, delivery: { error: "gone", at: "" } }, "person/delivery"],
    [
      {
        ...ticket,
        assignments: [{ id: ticket.assignments[0]!.id, createdAt: ticket.assignments[0]!.createdAt, state: "pending" }],
      },
      "working/queued",
    ],
    [{ ...ticket, ended: { at: "e", by: "human", reason: "Not needed after all", outcome: "stopped" } }, "stopped"],
    [{ ...ticket, ended: { at: "e", by: "executor", reason: "merged", outcome: "merged" } }, "merged"],
  ];
  for (const [item, state] of cases) expect(ticketCard(item).state).toBe(state);
  expect(
    cases.map(([item]) => ticketCard(item).state).every(state => (TICKET_STATES as readonly string[]).includes(state)),
  ).toBe(true);
  expect(ticketCard(cases[8]![0])).toMatchObject({ ended: { at: "e", by: "human", reason: "Not needed after all" } });
  expect(ticketCard(ticket)).toMatchObject({ ticket_id: "ticket-1", pr_number: 42, strength: "explicit" });
  expect(ticketCard(ticket)).not.toHaveProperty("attention");
  expect(ticketCard({ ...ticket, attention: { id: "q", question: "Desktop too?" } })).toMatchObject({
    attention: { question: "Desktop too?" },
  });
});

it("shows a decision with snake_case keys and a reference to its details", () => {
  const decision: Decision = {
    id: "d1",
    evalId: "e1",
    threadKey: "github:42",
    triggerIds: ["request-1"],
    policyVersion: "v1",
    at: "a",
    kind: "accept",
    reason: [said("r")],
    strength: "explicit",
    ticketId: "ticket-1",
    audit: { matches: [] },
  };
  expect(decisionCard(decision)).toEqual({
    decision_id: "d1",
    kind: "accept",
    reason: "r",
    strength: "explicit",
    thread: "github:42",
    trigger_ids: ["request-1"],
    ticket_id: "ticket-1",
    at: "a",
    read: "decision/d1",
  });
  expect(decisionDetails(decision)).toMatchObject({ decision_id: "d1", audit: { matches: [] } });
  // An Eval's id and a Policy version are hashes nothing reads by.
  expect(decisionDetails(decision)).not.toHaveProperty("eval_id");
  expect(decisionDetails(decision)).not.toHaveProperty("policy_version");
});

it("summarizes threads with their subscriptions and assessment state", () => {
  const evaluating = {
    id: "e1",
    threadKey: "github:42",
    triggerIds: ["x"],
    strength: "inferred" as const,
    actor: trigger.actor,
    basis: { via: "followup" as const },
    policyVersion: "v1",
    startedAt: "s",
    deadline: "d",
  };
  const thread: Thread = {
    key: "github:42",
    ref: { source: "github", id: "42" },
    createdAt: "",
    subscriptions: ["ticket-1"],
    correlated: [],
    pending: ["x"],
    evaluating,
    meta: { pollError: "boom" },
  };
  expect(threadCard(thread, "Fix the margin")).toEqual({
    thread: "github:42",
    label: "Fix the margin",
    source: "github",
    tickets: ["ticket-1"],
    evaluating: { since: "s", deadline: "d" },
    pending: 1,
    error: "boom",
    read: "thread/github:42",
  });
});

it("keeps what a model reads in a preview as written: code, angle brackets and link targets", () => {
  const text = "Fix `Map<string, T>` typing, see [the issue](https://github.com/acme/widgets/issues/7)\n\n  **now**";
  expect(triggerCard({ ...trigger, text }).preview).toBe(
    "Fix `Map<string, T>` typing, see [the issue](https://github.com/acme/widgets/issues/7) **now**",
  );
});
