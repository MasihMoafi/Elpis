import { fn } from "jest-mock";
import { Engine, MemoryRepositories, runningAssignment } from "./index.mts";
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Outcome, Policy, Ticket, Trigger } from "./index.mts";

export const member = { source: "chat", id: "alice" };

export const guest = { source: "chat", id: "guest" };

export function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
  return {
    id,
    source: "chat",
    threads: [{ source: "chat", id: "t1" }],
    actor: member,
    human: true,
    at: `2026-09-23T00:00:${id.padStart(2, "0")}Z`,
    text: `message ${id}`,
    channel: { source: "chat", thread: "t1", address: { message: id } },
    meta: {},
    ...overrides,
  };
}

export interface Hooks {
  emit?: (event: { type: string; data: Record<string, unknown> }) => void;
  prepareTicket?: EngineOptions["prepareTicket"];
}

export function harness(policyOverrides: Partial<Policy> = {}, { emit, prepareTicket }: Hooks = {}) {
  const repo = new MemoryRepositories();
  const outbox: OutboundMessage[] = [];
  const withdrawn: string[] = [];
  const requests: Candidate[] = [];
  const assessor: Assessor = {
    request: fn((candidate: Candidate) => {
      requests.push(candidate);
    }),
    release: fn(),
  };
  const launches: [Ticket, Assignment][] = [];
  const deliveries = new Set<string>();
  /** Inputs the Executor handed to a running assignment, as [ticket id, input id]. */
  const delivered: [string, string][] = [];
  const executor: Executor = {
    start: fn((ticket: Ticket, assignment: Assignment) => {
      launches.push([ticket, assignment]);
    }),
    deliver: fn((ticket: Ticket) => {
      deliveries.add(ticket.id);
    }),
    stop: fn(),
  };
  let version = "v1",
    paused = false;
  const policy: Policy = {
    get version() {
      return version;
    },
    get paused() {
      return paused;
    },
    evalTimeoutMs: 60_000,
    gate: (t, thread) =>
      !t.human
        ? { admissible: false, reason: "not human" }
        : t.actor.id === "alice"
          ? { admissible: true, strength: "explicit", basis: { via: "listed" } }
          : thread.subscriptions.length
            ? { admissible: true, strength: "inferred", basis: { via: "followup" } }
            : { admissible: false, reason: "not a member" },
    revalidate: () => version !== "revoked",
    admitsInferred: rules => rules.length > 0,
    ...policyOverrides,
  };
  let clock = 0;
  const scope: EngineOptions["scope"] = {
    scope: t =>
      t.meta.blocked ? { listened: false, reason: "chat not allowed" } : { listened: true, observed: false },
  };
  const queued: EngineOptions["outbox"] = {
    send: message => {
      if (!outbox.some(item => item.id === message.id)) outbox.push(message);
    },
    status: id => (outbox.some(item => item.id === id) ? "pending" : undefined),
    withdraw: id => {
      withdrawn.push(id);
    },
  };
  const engine = new Engine({
    repo,
    scope,
    policy: () => policy,
    assessor,
    executor,
    outbox: queued,
    ...(emit ? { emit } : {}),
    ...(prepareTicket ? { prepareTicket } : {}),
    now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString(),
  });
  /** Simulate the executor starting queued assignments (unless `launch` is false) and delivering pending ticket inputs. */
  function settle({ launch = true } = {}) {
    for (;;) {
      const next = launch ? launches.shift() : undefined;
      if (next) {
        engine.assignmentStarted(next[0].id, next[1].id);
        continue;
      }
      const [ticketId] = deliveries;
      if (ticketId === undefined) return;
      deliveries.delete(ticketId);
      const ticket = repo.tickets.get(ticketId)!;
      const assignment = runningAssignment(ticket);
      if (ticket.ended || !assignment) continue;
      for (const inputId of ticket.undelivered) {
        delivered.push([ticketId, inputId]);
        engine.inputsDelivered(ticketId, assignment.id, [inputId]);
      }
    }
  }
  const pump = () => {
    engine.evaluateDue();
    settle();
  };
  /** Simulate the worker's Session taking the delivered Trigger Inputs it has not yet read into a step. */
  const read = (ticketId: string) =>
    engine.inputsRead(
      ticketId,
      repo.tickets
        .get(ticketId)!
        .inputs.flatMap(input => (input.kind === "trigger" && input.readAt === null ? [input.id] : [])),
    );
  const decide = (candidate: Candidate, outcome: Outcome) =>
    engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId });
  return {
    repo,
    engine,
    outbox,
    withdrawn,
    requests,
    assessor,
    executor,
    delivered,
    settle,
    pump,
    read,
    decide,
    setVersion: (value: string) => {
      version = value;
    },
    setPaused: (value: boolean) => {
      paused = value;
    },
    tick: (seconds: number) => {
      clock += seconds;
    },
  };
}

export function accepted(h: ReturnType<typeof harness>, id = "1", thread = "t1") {
  h.engine.receive(trigger(id, { threads: [{ source: "chat", id: thread }] }));
  h.pump();
  const decision = h.decide(h.requests.at(-1)!, {
    kind: "accept",
    title: "Fix",
    scope: "small",
    reason: "requested",
    acknowledgement: "ok",
  });
  h.settle();
  return decision;
}
