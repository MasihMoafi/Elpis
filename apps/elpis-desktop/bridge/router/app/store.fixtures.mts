import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { type Assignment, type Thread, type Ticket } from "../core/index.mts";

export let directory: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "orchestrator-store-"));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

export const ticket = (
  id: string,
  state: "open" | "ended",
  assignments: Pick<Assignment, "state">[],
  undelivered: string[] = [],
): Ticket => ({
  id,
  title: id,
  decisionId: "",
  mandate: {
    strength: "explicit",
    policyVersion: "",
    basis: { via: "listed" },
    actor: { source: "x", id: "" },
    scope: "",
  },
  channels: [],
  assignments: assignments.map((item, index) => ({ id: `${id}-${index}`, createdAt: "", ...item })),
  inputs: [],
  ...(state === "ended"
    ? { ended: { at: "", by: "executor" as const, reason: "closed", outcome: "closed" as const } }
    : {}),
  undelivered,
  createdAt: "",
  updatedAt: "",
  origin: { triggerId: "", triggerIds: [] },
});

export const thread = (id: string, source: string, fields: Partial<Thread> = {}): Thread => ({
  key: `${source}:${id}`,
  ref: { source, id },
  createdAt: "",
  subscriptions: [],
  correlated: [],
  pending: [],
  meta: {},
  ...fields,
});

export const ids = (items: { id?: string; key?: string }[]) => items.map(item => item.id ?? item.key).sort();
