// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/resources.ts.
/** Serves paginated context resources to orchestrator_read so large bodies stay out of model prompts until requested. */
type SessionId = string;
import {
  UserError,
  key,
  latestReport,
  reached,
  runningAssignment,
  threadKey,
  type Ticket,
  type Trigger,
} from "../core/index.mts";
import { batchOf, inputMessage, triggerMessage, workerSessionId } from "../executor/messages.mts";
import { readGithub } from "../sources/github-read.mts";
import { chatRead } from "../sources/elpis-chat-read.mts";
import type { ElpisChatTransport } from "../sources/elpis-chat.mts";
import {
  ASSIGNMENTS,
  INPUTS,
  assignmentLine,
  decisionCard,
  decisionDetails,
  inputLine,
  newestPage,
  preview,
  textPage,
  threadCard,
  ticketCard,
  ticketDetails,
  triggerCard,
  type TicketThread,
} from "./cards.mts";
import { threadTitle } from "./views/records.mts";
import { transcriptEntry } from "./context.mts";
import { builtInParts, defaultPrompts } from "./prompts.mts";
import type { AppContext as Context } from "./host.mts";
import type { Commands } from "../infra/commands.mts";
import type { PromptVersion, Prompts } from "./prompts.mts";
import type { Sessions } from "../executor/sessions.mts";
import type { Settings } from "./settings.mts";
import type { Store } from "./store.mts";
import type { TextCache } from "./cache.mts";

export { RESOURCES, resourceGrammar } from "./resource-names.mts";

export interface ResourceHost {
  readonly store: Pick<
    Store,
    "get" | "settings" | "triggers" | "tickets" | "threads" | "read" | "decisions" | "replyStatus"
  >;
  readonly pages: TextCache;
  readonly prompts: Pick<Prompts, "current" | "version" | "history" | "skills" | "defaultChanged">;
  readonly commands: Commands;
  readonly masterId: string;
  readonly context: Context;
  promptVersion(sessionId: string): PromptVersion;
  /** Whether a Session may read `revision` (the revision it currently runs under or any revision it ran under previously). */
  mayRead(sessionId: string, revision: number): boolean;
  readonly chat: ElpisChatTransport;
  repliesTo(trigger: Trigger): string | undefined;
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>;
}
export interface MainResourceHost extends ResourceHost {
  readonly sessions: Pick<Sessions, "status" | "modelRetry">;
  readonly settings: Pick<Settings, "view" | "block">;
}
interface Read {
  host: ResourceHost;
  resource: string;
  rest: string;
  offset: number;
  limit?: number;
  sessionId: string;
  ticketId?: string;
  signal?: AbortSignal;
}
type Route = readonly [name: string, read: (read: Read) => unknown];

/** Enforces that main-Session-only resources cannot be read by worker Sessions. */
const main = ({ host, ticketId }: Read): MainResourceHost => {
  if (ticketId || !("settings" in host)) throw new Error("This resource belongs to the main Session");
  return host as MainResourceHost;
};
const text = ({ resource, offset, limit }: Read, body: string) => textPage(resource, body, offset, limit ?? 4000);
function list<T>({ offset, limit }: Read, fetch: (offset: number, count: number) => T[]) {
  const size = Math.min(limit ?? 20, 50);
  const items = fetch(offset, size + 1);
  return { items: items.slice(0, size), next_offset: items.length > size ? offset + size : null };
}
/** Check whether a worker session's ticket is authorized to read a trigger (via delivery, ticket origin, or followed thread). */
const readable = (host: ResourceHost, ticket: Ticket, trigger: Trigger): boolean =>
  reached(ticket, trigger, key => host.store.threads.get(key)) ||
  ticket.origin.triggerIds.includes(trigger.id) ||
  trigger.threads.some(ref => ticket.follows?.some(follow => follow.thread === threadKey(ref)));
const trigger = (host: ResourceHost, id: string, ticketId?: string): Trigger => {
  const found = host.store.triggers.get(id);
  if (!found) throw new UserError("unknownTrigger");
  const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined;
  if (ticketId && (!ticket || !readable(host, ticket, found))) throw new UserError("notReached");
  return found;
};
/** Fetch and cache a source resource on offset 0, serving subsequent offsets from the session cache. */
async function sourcePage(read: Read, source: string, fetch: () => Promise<unknown>) {
  const { host, resource, offset, sessionId } = read;
  const body = offset === 0 ? JSON.stringify(await fetch()) : host.pages.get(`${sessionId}:${resource}`);
  if (body === undefined) throw new Error(`Read this ${source} resource from offset 0 first`);
  if (offset === 0) host.pages.set(`${sessionId}:${resource}`, body);
  return text(read, body);
}
const THREAD_DECISIONS = 5;
const triggerLine = (trigger: Trigger) => ({
  trigger_id: trigger.id,
  actor: trigger.actor.id,
  human: trigger.human,
  at: trigger.at,
  preview: preview(trigger.text),
  chars: trigger.text.length,
  read: `trigger/${trigger.id}`,
});
async function transcript(host: ResourceHost, ticketId: string) {
  return (await host.context.sessionController.inspect(workerSessionId(ticketId) as SessionId)).events;
}

const ROUTES: readonly Route[] = [
  [
    "tickets",
    read => {
      const host = main(read),
        tickets = host.store.tickets.list();
      const card = (ticket: Ticket) => ({
        ...ticketCard(ticket),
        ...host.sessions.modelRetry(runningAssignment(ticket) && workerSessionId(ticket.id)),
      });
      return list(read, (offset, count) => tickets.slice(offset, offset + count).map(card));
    },
  ],
  [
    "triggers",
    read => {
      const { store } = main(read);
      return list(read, (offset, count) =>
        store.read.recentTriggers(offset, count).map(item => triggerCard(item, store.triggers.disposition(item.id))),
      );
    },
  ],
  [
    "threads",
    read => {
      const { store } = main(read);
      const threads = store.read
        .subscribedThreads()
        .sort((a, b) => (b.lastAt ?? b.createdAt).localeCompare(a.lastAt ?? a.createdAt));
      return list(read, (offset, count) =>
        threads.slice(offset, offset + count).map(thread => threadCard(thread, threadTitle(store, thread))),
      );
    },
  ],
  [
    "thread/",
    read => {
      const { host, rest, ticketId } = read;
      const thread = host.store.threads.get(rest);
      const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined;
      // Worker Sessions may only read threads their own ticket subscribes to or follows.
      if (
        !thread ||
        (ticketId &&
          !(thread.subscriptions.includes(ticketId) || ticket?.follows?.some(follow => follow.thread === rest)))
      ) {
        throw new Error("Unknown or inaccessible thread");
      }
      const { store } = host;
      const { read: _read, tickets: ids, ...card } = threadCard(thread, threadTitle(store, thread));
      const page = list(read, (offset, count) => store.read.threadPage(thread.key, offset, count).map(triggerLine));
      // Worker sessions cannot inspect other tickets or decisions on a shared thread.
      if (ticketId) return { ...card, ...page };
      const tickets = ids.flatMap(id => {
        const found = store.tickets.get(id);
        return found ? [ticketCard(found)] : [];
      });
      const decisions = store.decisions.byThread(thread.key).slice(-THREAD_DECISIONS).reverse().map(decisionCard);
      return { ...card, tickets, decisions, ...page };
    },
  ],
  [
    "decisions",
    read => list(read, (offset, count) => main(read).store.read.recentDecisions(offset, count).map(decisionCard)),
  ],
  [
    "decision/",
    read => {
      const decision = main(read).store.decisions.get(read.rest);
      if (!decision) throw new Error("Unknown decision");
      return decisionDetails(decision);
    },
  ],
  ["settings", read => main(read).settings.view()],
  ["settings/", read => text(read, JSON.stringify(main(read).settings.block(read.rest)))],
  [
    "prompts",
    read => {
      const host = main(read),
        current = host.prompts.current(),
        status = host.sessions.status();
      const history = host.prompts.history(read.offset, Math.min(read.limit ?? 20, 50)),
        skills = host.prompts.skills(current.config).map(([name]) => name);
      // The built-in parts whose text changed since the team overrode them, and those this version no longer has, which the
      // panel shows and the next save drops.
      const changes = host.prompts.defaultChanged(current.config);
      const changed = changes.filter(item => !item.removed).map(item => item.part);
      const removed = changes.filter(item => item.removed).map(item => item.part);
      return {
        revision: status.revision,
        read: `prompts/${current.revision}`,
        notification_pending: status.notificationPending,
        ...(changed.length ? { default_changed: changed } : {}),
        ...(removed.length ? { removed_parts: removed } : {}),
        sessions: status.sessions.map(session => ({ session_id: session.sessionId, revision: session.revision })),
        skills: {
          built_in: skills.filter(name => !(name in current.config.skills)).map(name => `mother-${name}`),
          team: Object.keys(current.config.skills).map(name => `mother-${name}`),
        },
        items: history.revisions.map(({ previousRevision, savedAt, ...version }) => ({
          ...version,
          previous_revision: previousRevision,
          saved_at: savedAt,
        })),
        next_offset: history.next_offset,
      };
    },
  ],
  // A worker Session may read only its current prompt revision and revisions it previously ran under.
  [
    "prompts/",
    read => {
      const { host, resource, rest, sessionId, ticketId } = read;
      const prompts = host.prompts;
      const bound = host.promptVersion(sessionId);
      const parts = () => Object.fromEntries(Object.entries(builtInParts()).map(([key, part]) => [key, part.text]));
      const version =
        rest === "current"
          ? bound
          : rest === "defaults" && !ticketId
            ? { revision: 0, config: defaultPrompts(), parts: parts() }
            : /^\d+$/.test(rest)
              ? Number(rest) === 0 && prompts.current().revision === 0
                ? prompts.current()
                : prompts.version(Number(rest))
              : undefined;
      if (!version || (ticketId && !host.mayRead(sessionId, version.revision)))
        throw new Error("Unknown or inaccessible prompt version");
      return text(
        { ...read, resource: rest === "current" ? `prompts/${version.revision}` : resource },
        JSON.stringify(version),
      );
    },
  ],
  [
    "prompt-preview/",
    read => {
      const body = main(read).pages.get(`${read.sessionId}:${read.resource}`);
      if (body === undefined) throw new Error("Unknown preview for this Session");
      return text(read, body);
    },
  ],
  [
    "models",
    async read => {
      const host = main(read),
        catalog = await host.context.sessionController.modelCatalog(),
        settings = host.store.settings();
      const roles = { orchestrator: settings.eval.model, worker: settings.executor.model };
      return {
        default: catalog.default,
        roles,
        failures: catalog.failures,
        providers: catalog.groups.map(group => ({
          id: group.id,
          name: group.name,
          count: group.models.length,
          read: `models/${group.id}`,
        })),
      };
    },
  ],
  [
    "models/",
    async read => {
      const models = (await main(read).context.sessionController.modelCatalog()).groups.find(
        group => group.id === read.rest,
      )?.models;
      if (!models) throw new Error("Unknown model provider");
      return list(read, (offset, count) => models.slice(offset, offset + count));
    },
  ],
  [
    "elpis-chat/",
    async read => {
      const source = trigger(read.host, read.rest.split("/")[0]!, read.ticketId);
      if (source.source !== "elpis-chat") throw new Error("An Elpis chat trigger is required");
      if (read.resource.split("/")[2] === "image") return chatRead(read.host.chat, source, read.resource, read.signal);
      return sourcePage(read, "Elpis chat", () => chatRead(read.host.chat, source, read.resource, read.signal));
    },
  ],
  [
    "github/",
    read => sourcePage(read, "github", () => readGithub(read.host.commands.withSignal(read.signal), read.resource)),
  ],
  [
    "trigger/",
    async read => {
      const { host, rest, ticketId, offset, signal } = read;
      if (!rest || rest.includes("/")) throw new Error("Unknown context resource");
      const found = trigger(host, rest, ticketId);
      // Redact decision IDs, other tickets, and unreachable neighbour triggers when a worker session reads a trigger.
      const ticket = ticketId ? host.store.tickets.get(ticketId) : undefined;
      const shown = (item: Trigger | undefined) =>
        item && (!ticket || readable(host, ticket, item)) ? item : undefined;
      const disposition = host.store.triggers.disposition(found.id);
      const { decisionId: _decisionId, ...withoutDecision } = disposition ?? { fanout: [], at: "" };
      const visible =
        disposition && ticket
          ? { ...withoutDecision, fanout: disposition.fanout.filter(id => id === ticket.id) }
          : disposition;
      // Omit card preview and self-reference because this resource returns the full text.
      const { preview: _preview, chars: _chars, read: _read, ...card } = triggerCard(found, visible);
      const parent = host.repliesTo(found);
      const repliedTo = shown(parent ? host.store.triggers.get(parent) : undefined);
      const neighbours = host.store.read.neighbours(threadKey(found.threads[0]!), found.at, found.id);
      const around = { before: shown(neighbours.before), after: shown(neighbours.after) };
      return {
        ...card,
        ...(await host.sourceLink(found, signal)),
        acknowledgement: host.store.replyStatus(key("ack", found.id)) ?? "not_requested",
        ...(found.source === "elpis-chat"
          ? { context: { message: `elpis-chat/${found.id}/message`, thread: `elpis-chat/${found.id}/thread` } }
          : {}),
        ...(offset === 0
          ? {
              ...(repliedTo ? { replied_to: triggerLine(repliedTo) } : {}),
              around: {
                ...(around.before ? { before: triggerLine(around.before) } : {}),
                ...(around.after ? { after: triggerLine(around.after) } : {}),
              },
            }
          : {}),
        ...text(read, found.text),
      };
    },
  ],
  [
    "ticket/",
    async read => {
      const { host, resource, rest, ticketId, signal } = read;
      const [id, section, part, ...more] = rest.split("/");
      if (!id || more.length) throw new Error("Unknown context resource");
      if (ticketId && ticketId !== id) throw new Error("Ticket does not belong to this worker");
      const ticket = host.store.tickets.get(id);
      if (!ticket) throw new UserError("unknownTicket");
      if (section === undefined) {
        const running = runningAssignment(ticket) && workerSessionId(ticket.id);
        const retry = "sessions" in host ? (host as MainResourceHost).sessions.modelRetry(running) : {};
        // Merge subscribed threads (including context-only subscriptions) and source-bound threads without duplicates.
        const bound = new Set((ticket.follows ?? []).map(follow => follow.thread));
        const subscribed = host.store.read.subscribedThreads().filter(thread => thread.subscriptions.includes(id));
        const marked = (key: string, context: boolean): TicketThread => ({
          thread: key,
          ...(context ? { context: true } : {}),
          ...(bound.has(key) ? { bound: true } : {}),
        });
        const threads = [
          ...subscribed.map(thread => marked(thread.key, !!thread.context?.includes(id))),
          ...[...bound].filter(key => !subscribed.some(thread => thread.key === key)).map(key => marked(key, false)),
        ];
        return { ...ticketDetails(ticket, threads, batchOf(host, ticket), !!ticketId), ...retry };
      }
      if (section === "assignments" || section === "inputs") {
        if (part !== undefined) throw new Error("Unknown context resource");
        const size = Math.min(read.limit ?? (section === "assignments" ? ASSIGNMENTS : INPUTS), 50);
        const { items, next_offset } =
          section === "assignments"
            ? newestPage(ticket.assignments, read.offset, size, item => assignmentLine(ticket, item), resource)
            : newestPage(ticket.inputs, read.offset, size, input => inputLine(ticket, input, !!ticketId), resource);
        return { items, next_offset: next_offset ?? null };
      }
      let body: string;
      if (section === "input" && part) {
        // Render the input on demand with its resolved source link, matching either its short key or full input ID.
        const input = ticket.inputs.find(item => key(item.id) === part || item.id === part);
        const trigger = input?.kind === "trigger" ? host.store.triggers.get(input.triggerId) : undefined;
        const card =
          trigger && input?.kind === "trigger"
            ? triggerMessage(trigger, await host.sourceLink(trigger, signal), input.note)
            : undefined;
        const message = input && inputMessage(input, card);
        if (message === undefined) throw new Error("Unknown ticket input");
        body = message;
      } else if (section === "message" && part && /^\d+$/.test(part)) {
        const event = (await transcript(host, id))[Number(part)];
        const entry = event && transcriptEntry(event);
        if (!entry) throw new Error("Unknown transcript entry");
        body = JSON.stringify(entry);
      } else if (section === "report" && part) {
        const report = ticket.assignments.find(item => item.id === part)?.report;
        if (!report) throw new Error("Unknown assignment report");
        body = report.summary;
      } else if (part !== undefined) throw new Error("Unknown context resource");
      else if (section === "assignment") body = ticket.execution?.assignment ?? "";
      else if (section === "result") body = latestReport(ticket)?.summary ?? "";
      else if (section === "transcript") {
        body = (await transcript(host, id))
          .flatMap((event, index) => {
            const entry = transcriptEntry(event);
            const said =
              entry?.message.content.map(block => (block.type === "text" ? block.text : `[${block.type}]`)).join(" ") ??
              "";
            return entry
              ? [
                  {
                    type: entry.type,
                    preview: preview(said).slice(0, 80),
                    chars: JSON.stringify(entry).length,
                    read: `ticket/${id}/message/${index}`,
                  },
                ]
              : [];
          })
          .reverse()
          .map(event => JSON.stringify(event))
          .join("\n");
      } else throw new Error("Unknown context resource");
      return text(read, body);
    },
  ],
];

/**
 * Read a paginated resource for the main Session or a ticket's worker Session.
 * Legacy prefixes (`event/`, `task/`, `observation/`) remain accepted so references in older Session history stay readable.
 */
export function readResource(
  host: ResourceHost,
  resource: string,
  offset: number,
  limit: number | undefined,
  ticketId?: string,
  signal?: AbortSignal,
) {
  const name = resource
    .replace(/^event\//, "trigger/")
    .replace(/^task\//, "ticket/")
    .replace(/^observation\//, "decision/");
  const route = ROUTES.find(([route]) => (route.endsWith("/") ? name.startsWith(route) : name === route));
  if (!route) throw new Error("Unknown context resource");
  const sessionId = ticketId ? workerSessionId(ticketId) : host.masterId;
  const rest = route[0].endsWith("/") ? name.slice(route[0].length) : "";
  return route[1]({
    host,
    resource: name,
    rest,
    offset,
    sessionId,
    ...(limit ? { limit } : {}),
    ...(ticketId ? { ticketId } : {}),
    ...(signal ? { signal } : {}),
  });
}
