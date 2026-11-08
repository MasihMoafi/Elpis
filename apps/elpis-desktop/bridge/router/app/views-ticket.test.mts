import { it } from "node:test";
import { expect } from "expect";
import { vi } from "../test-support.mts";
import { snapshot, triggerView } from "./views/records.mts";
import { followupOwners } from "../core/index.mts";
import { store, views, at, live, message } from "./views.fixtures.mts";

it("offers a person to send a follow-up to Eval while a ticket decides it, or once nothing did", () => {
  const host = views();
  live("t1");
  store.threads.save({
    key: "feishu:oc_1:om_root",
    ref: { source: "feishu", id: "oc_1:om_root" },
    createdAt: at,
    subscriptions: ["t1"],
    correlated: [],
    pending: [],
    meta: {},
  });
  store.triggers.save(message("f1", { source: "feishu", id: "ou_alice" }));
  store.triggers.saveDisposition("f1", { fanout: ["t1"], at });
  const row = () => triggerView(snapshot(host), store.triggers.get("f1")!);
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: true } });
  // A ticket that ended after its worker had it leaves it to nobody: a person may still send it to Eval.
  store.tickets.save({
    ...store.tickets.get("t1")!,
    ended: { at, by: "executor", reason: "done", outcome: "completed" },
  });
  expect(row()).toMatchObject({ actions: { requeue: true }, disposition: { delivered: false } });
  // Not once its worker acknowledged it, which took it up; a stop on it decided only the ticket's work.
  store.triggers.saveDisposition("f1", { fanout: ["t1"], acked: ["t1"], at });
  expect(row().actions.requeue).toBe(false);
  store.decisions.save({
    id: "stop",
    evalId: "e",
    threadKey: "feishu:oc_1:om_root",
    triggerIds: ["f1"],
    policyVersion: "v",
    at,
    kind: "stop",
    reason: [{ code: "humanStop" }],
    strength: "explicit",
    ticketId: "t1",
  });
  store.triggers.saveDisposition("f1", { fanout: ["t1"], decisionId: "stop", at });
  expect(row().actions.requeue).toBe(true);
  // So once the stop ended the ticket, which let go of the message, as the Engine records it.
  store.triggers.saveDisposition("f1", { fanout: [], decisionId: "stop", at });
  expect(row().actions.requeue).toBe(true);
  // Once sent, it waits for the Eval.
  store.threads.save({ ...store.threads.get("feishu:oc_1:om_root")!, pending: ["f1"] });
  store.triggers.saveDisposition("f1", { fanout: ["t1"], requeued: true, at });
  expect(row()).toMatchObject({ actions: { requeue: false }, disposition: { queued: true } });
});

it("reads each ticket a page's follow-ups reached once, and nothing for a message no ticket can decide", () => {
  const host = views();
  live("t1");
  store.threads.save({
    key: "feishu:oc_1:om_root",
    ref: { source: "feishu", id: "oc_1:om_root" },
    createdAt: at,
    subscriptions: ["t1"],
    correlated: [],
    pending: [],
    meta: {},
  });
  for (const id of ["f1", "f2", "f3"]) {
    store.triggers.save(message(id, { source: "feishu", id: "ou_alice" }));
    store.triggers.saveDisposition(id, { fanout: ["t1"], at });
  }
  const view = snapshot(host);
  const tickets = vi.spyOn(store.tickets, "get");
  expect(["f1", "f2", "f3"].map(id => triggerView(view, store.triggers.get(id)!).disposition.delivered)).toEqual([
    true,
    true,
    true,
  ]);
  expect(tickets).toHaveBeenCalledTimes(1);
  tickets.mockRestore();
  // A message the ticket handed back is decided by no ticket, which needs no read.
  store.triggers.saveDisposition("f3", {
    fanout: ["t1"],
    handbacks: [{ ticketId: "t1", reason: "Another change", at }],
    at,
  });
  const records = {
    tickets: { get: vi.fn<typeof store.tickets.get>() },
    threads: { get: vi.fn<typeof store.threads.get>() },
    triggers: store.triggers,
  };
  expect(followupOwners(store.triggers.get("f3")!, records)).toEqual([]);
  expect([records.tickets.get, records.threads.get].map(read => read.mock.calls.length)).toEqual([0, 0]);
});
