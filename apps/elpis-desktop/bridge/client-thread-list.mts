import { AGENT_RUN_NOTICE, agentParentId, isAgentRun } from "../lib/agent-runs.mts";
import { BridgeError, object, text, threadId } from "./validate.mts";
import { createdThread } from "./spawn-links.mts";
import { interviewTurns, legacyInterview } from "./love-interview.mts";
import { recordedMedia } from "./attachments.mts";
import { rolloutAgentModel } from "./elpis-features.mts";
import fs from "node:fs/promises";
import path from "node:path";

import { internal_browserOptions, internal_rpc } from "./client-rpc.mts";
import { internal_withTurnModels } from "./client-rollout-cache.mts";
import voiceHandoff from "./voice-handoff.cts";
import type { DesktopClient } from "./client.mts";
import type { ArchiveOptions } from "./client-archive-history.mts";
import type { ClientState } from "./client-state.mts";

function readListedThread(client: Parameters<typeof internal_rpc>[0], clientState: ClientState, id: string) {
  return internal_rpc(client, clientState, "thread/read", { threadId: id, includeTurns: false }).then(
    result => result.thread,
    () => undefined,
  );
}

export const { isVoiceHandoff } = voiceHandoff;

/** Every kind of conversation the window lists, agents included. */
export const SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

const CHAT_SOURCE_KINDS = ["cli", "vscode", "appServer", "unknown"];

/** Search reads at most this many pages of 100 chats for names (2,000 chats). */
const SEARCH_SCAN_PAGES = 20;

/** The cursor of a page cut from whole turns (see #itemsPage); the engine's own cursors never start with it. */
const WHOLE_TURNS = "whole-turns:";

/** The engine's Claude Code import ends the last turn with this agent message, after the chat's real last reply
 * (codex-rs/external-agent-migration, EXTERNAL_SESSION_IMPORTED_MARKER). It is a note for the engine, not a reply. */
const IMPORT_MARKER = "<EXTERNAL SESSION IMPORTED>";

const agentModels = new Map<string, { key: string; value: Awaited<ReturnType<typeof rolloutAgentModel>> }>();
async function recordedAgentModel(thread: DecoratedInput) {
  if (!isAgentRun(thread) || typeof thread.path !== "string") return;
  const stat = await fs.stat(thread.path).catch(() => null);
  if (!stat?.isFile()) return;
  const key = `${stat.size}:${stat.mtimeMs}`,
    cached = agentModels.get(thread.path);
  const value = cached?.key === key ? cached.value : await rolloutAgentModel(thread.path, thread.id);
  if (cached?.key !== key) {
    if (agentModels.size >= 500) agentModels.delete(agentModels.keys().next().value!);
    agentModels.set(thread.path, { key, value });
  }
  if (value) Object.assign(thread, value);
}

const notImportMarker = (entry: unknown) => {
  const value = entry as { item?: { type?: unknown; text?: unknown } } | null | undefined;
  return !(value?.item?.type === "agentMessage" && value.item.text === IMPORT_MARKER);
};

type ThreadSource =
  string | { custom?: string; subAgent?: string | { other?: unknown; thread_spawn?: { agent_path?: unknown } } };
export const subAgentSource = (source: ThreadSource | undefined) =>
  typeof source === "object" && typeof source?.subAgent === "object" ? source.subAgent : undefined;

export type ThreadListOptions = {
  cursor?: unknown;
  limit?: unknown;
  ancestorThreadId?: unknown;
  archived?: unknown;
  searchTerm?: unknown;
  includeAgentRuns?: unknown;
};
export type ListedThread = {
  id: string;
  parentThreadId?: string | null | undefined;
  source?: ThreadSource | undefined;
  status?: { type?: string } | undefined;
  [key: string]: unknown;
};
export type EngineItem = Parameters<typeof interviewTurns>[0][number]["items"][number] & { path?: string };
export type EngineTurn = Omit<Parameters<typeof interviewTurns>[0][number], "id" | "items"> & {
  id: string;
  status?: string;
  items: EngineItem[];
};
export type DecoratedInput = {
  id: string;
  archived?: boolean | undefined;
  cwd?: string | undefined;
  path?: string | null | undefined;
  name?: string | null | undefined;
  preview?: string | null | undefined;
  model?: string | null | undefined;
  modelProvider?: string | undefined;
  reasoningEffort?: string | null | undefined;
  turns?: EngineTurn[] | undefined;
  parentThreadId?: string | null | undefined;
  source?: ThreadSource | undefined;
  status?: { type?: string } | undefined;
  canAcceptDirectInput?: boolean | null | undefined;
  workflowTaskTitle?: string | undefined;
  [key: string]: unknown;
};

const isArchivedThread = (thread: Pick<DecoratedInput, "archived" | "path">) =>
  thread.archived === true ||
  (typeof thread.path === "string" && path.basename(path.dirname(thread.path)) === "archived_sessions");

/** A thread's status, corrected by its newest turn: "active" whose newest turn has ended is idle. No turn yet (a
 * bridged chat's first turn is listed only once it ends) or an unreadable list keeps the status as listed. */
export function settledStatus<T>(status: T, newestTurns: unknown): T | { type: string } {
  const current = status as { type?: unknown } | null | undefined;
  const newest = Array.isArray(newestTurns) ? newestTurns[0] : undefined;
  if (current?.type !== "active" || !newest?.status || newest.status === "inProgress") return status;
  return { type: "idle" };
}

async function internal_loadWorkflowTitles(this: DesktopClient, clientState: ClientState, threads: ListedThread[]) {
  const candidates = threads.flatMap(thread => {
    const source = subAgentSource(thread.source)?.other;
    const match = typeof source === "string" && /^work_graph:([0-9a-f-]{36}):(.+)$/.exec(source);
    if (!match || clientState.workflowTitles.has(thread.id)) return [];
    return [{ thread, source, graphId: match[1]!, taskId: match[2]!, rootThreadId: thread.parentThreadId }];
  });
  // Native thread/list can omit the parent of Other(work_graph) workers even
  // while thread/read reports it. Recover only recognised workers, then verify
  // the graph's assigned thread before projecting a title or parent.
  const validParent = (row: { rootThreadId: string | null | undefined; thread: { id: string } }) => {
    try {
      return threadId(row.rootThreadId) !== row.thread.id;
    } catch {
      return false;
    }
  };
  const missing = candidates.filter(row => !validParent(row)).slice(0, 16);
  await Promise.all(
    missing.map(async row => {
      const read = await internal_rpc(this, clientState, "thread/read", {
        threadId: row.thread.id,
        includeTurns: false,
      }).catch(() => null);
      if (read?.thread?.id === row.thread.id && subAgentSource(read.thread.source)?.other === row.source)
        row.rootThreadId = read.thread.parentThreadId;
    }),
  );
  const linked = candidates.filter(validParent);
  // Cap distinct parents for a large list page; verified metadata is reused.
  await Promise.all(
    [...new Set(linked.map(row => row.rootThreadId))].slice(0, 16).map(async rootThreadId => {
      let lookup = clientState.workflowLookups.get(rootThreadId);
      if (!lookup) {
        lookup = internal_rpc(this, clientState, "workGraph/list", { rootThreadId })
          .catch(() => null)
          .finally(() => clientState.workflowLookups.delete(rootThreadId));
        clientState.workflowLookups.set(rootThreadId, lookup);
      }
      const result = await lookup;
      for (const row of linked.filter(row => row.rootThreadId === rootThreadId)) {
        const graph = result?.data?.find((graph: { id?: unknown }) => graph.id === row.graphId);
        const task = graph?.tasks?.find(
          (task: { id?: unknown; assignedThreadId?: unknown }) =>
            task.id === row.taskId && task.assignedThreadId === row.thread.id,
        );
        if (typeof rootThreadId === "string" && typeof task?.title === "string" && task.title.trim())
          clientState.workflowTitles.set(row.thread.id, { source: row.source, title: task.title.trim(), rootThreadId });
      }
    }),
  );
}

/** A chat made by another chat's create_thread call belongs under it; the window already lists it on its own, so tell it. */
export async function internal_learnSpawn(
  this: DesktopClient,
  clientState: ClientState,
  maker: unknown,
  item: unknown,
) {
  const child = createdThread(item);
  if (!child || !(await clientState.spawnLinks.record(child, maker).catch(() => false))) return;
  const { thread } = await internal_rpc(this, clientState, "thread/read", {
    threadId: child,
    includeTurns: false,
  }).catch(() => ({ thread: undefined }));
  if (thread?.id === child)
    this.emit("event", {
      type: "message",
      data: { method: "thread/started", params: { thread: internal_decorate.call(this, clientState, thread) } },
    });
}

export function internal_decorate<T>(this: DesktopClient, clientState: ClientState, raw: T) {
  let thread = raw as T & DecoratedInput;
  if (!thread || typeof thread.id !== "string") throw new BridgeError("Elpis returned an invalid thread", 502);
  if (legacyInterview(thread as Parameters<typeof legacyInterview>[0])) clientState.interviewThreads.add(thread.id);
  if (clientState.interviewThreads.has(thread.id))
    thread = {
      ...thread,
      preview: "",
      ...(Array.isArray(thread.turns) ? { turns: interviewTurns(thread.turns) } : {}),
    };
  const parentThreadId =
    agentParentId(thread as Parameters<typeof agentParentId>[0]) ?? clientState.spawnLinks.makerOf(thread.id);
  if (parentThreadId) thread = { ...thread, parentThreadId };
  clientState.known.add(thread.id);
  const recorded = clientState.workflowTitles.get(thread.id);
  if (
    recorded?.source === subAgentSource(thread.source)?.other &&
    recorded &&
    (!thread.parentThreadId || thread.parentThreadId === recorded.rootThreadId)
  ) {
    thread.workflowTaskTitle = recorded.title;
    thread.parentThreadId ??= recorded.rootThreadId;
  }
  const background = isAgentRun(thread);
  const parentOwned =
    background ||
    thread.canAcceptDirectInput === false ||
    (thread.canAcceptDirectInput == null &&
      typeof subAgentSource(thread.source)?.thread_spawn?.agent_path === "string");
  return {
    ...thread,
    desktopAccess: {
      writable: !parentOwned,
      mode: parentOwned ? "continue" : "direct",
      canContinue: parentOwned && ["idle", "notLoaded"].includes(thread.status?.type as string),
      reason: parentOwned ? AGENT_RUN_NOTICE : null,
    },
  };
}

export function internal_forget(this: DesktopClient, clientState: ClientState, id: string) {
  clientState.browserConfig?.close?.(id);
  internal_forgetSubscription.call(this, clientState, id);
  clientState.known.delete(id);
  clientState.context.delete(id);
  clientState.attaching.delete(id);
  clientState.workflowTitles.delete(id);
  clientState.turnRevisions.delete(id);
}

export async function impl_listThreads(this: DesktopClient, clientState: ClientState, input: unknown = {}) {
  const options = object(input, [
    "cursor",
    "limit",
    "ancestorThreadId",
    "archived",
    "searchTerm",
    "includeAgentRuns",
  ]) as ThreadListOptions;
  if (options.includeAgentRuns !== undefined && typeof options.includeAgentRuns !== "boolean")
    throw new BridgeError("includeAgentRuns must be true or false");
  const includeAgentRuns = options.includeAgentRuns === true || !!options.ancestorThreadId;
  const searchTerm =
    options.searchTerm === undefined ? undefined : text(options.searchTerm, "conversation search", 200);
  const result = await internal_rpc(this, clientState, "thread/list", {
    limit: options.limit ?? 50,
    cursor: options.cursor,
    modelProviders: [],
    ...(options.archived === true ? { archived: true } : {}),
    ...(searchTerm ? { searchTerm: searchTerm.trim() } : {}),
    sourceKinds: includeAgentRuns ? SOURCE_KINDS : CHAT_SOURCE_KINDS,
    ...(options.ancestorThreadId ? { ancestorThreadId: threadId(options.ancestorThreadId) } : {}),
  });
  // The engine's search matches a chat's first message in exact letter case and misses a name given later, so "main" did
  // not find the chat named main once it was past the loaded page. Match names and first messages in any case over the
  // whole list, as the Codex resume picker matches its rows (tui/src/resume_picker.rs, matches_query).
  if (searchTerm && !options.cursor && !options.archived && !options.ancestorThreadId) {
    const term = searchTerm.trim().toLowerCase(),
      seen = new Set(result.data.map((thread: { id: string }) => thread.id));
    let cursor: string | null | undefined;
    for (let page = 0; page < SEARCH_SCAN_PAGES; page++) {
      const listed = await internal_rpc(this, clientState, "thread/list", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
        modelProviders: [],
        sourceKinds: includeAgentRuns ? SOURCE_KINDS : CHAT_SOURCE_KINDS,
      });
      for (const thread of listed.data ?? [])
        if (
          !seen.has(thread.id) &&
          `${thread.name ?? ""} ${thread.preview ?? ""} ${(thread.agentNickname as string | undefined) ?? ""}`
            .toLowerCase()
            .includes(term)
        ) {
          seen.add(thread.id);
          result.data.push(thread);
        }
      if (!(cursor = listed.nextCursor)) break;
    }
  }
  // A native fork has no first_user_message of its own until another turn. Keep the current rewind checkpoint
  // discoverable across desktop restarts without inventing a user message just to make the engine list it.
  if (!options.cursor && !options.ancestorThreadId && !options.archived) {
    for (const id of new Set([
      ...(await clientState.rewindHistory.currentIds()),
      ...(await clientState.versions.listed()),
    ])) {
      if (result.data.some((thread: { id: string }) => thread.id === id)) continue;
      const thread = await readListedThread(this, clientState, id);
      if (!thread || isArchivedThread(thread)) continue;
      if (
        searchTerm &&
        !`${thread.name ?? ""} ${thread.preview ?? ""}`.toLowerCase().includes(searchTerm.trim().toLowerCase())
      )
        continue;
      result.data.unshift(thread);
    }
  }
  // The engine relates a chat only to the agents it spawned itself; add the chats made by create_thread.
  if (!options.archived && !options.ancestorThreadId && !searchTerm) {
    await clientState.spawnLinks
      .recover(
        result.data as Parameters<typeof clientState.spawnLinks.recover>[0],
        (cursor: unknown) =>
          internal_rpc(this, clientState, "thread/list", {
            limit: 100,
            cursor,
            modelProviders: [],
            sourceKinds: SOURCE_KINDS,
          }) as ReturnType<Parameters<typeof clientState.spawnLinks.recover>[1]>,
      )
      .catch(() => {});
    // The creator may be on an older history page. Its children still need their real row here.
    for (const child of [...result.data]) {
      const maker = clientState.spawnLinks.thread(clientState.spawnLinks.makerOf(child.id));
      if (maker && !result.data.some((thread: { id: string }) => thread.id === maker.id))
        result.data.push(maker as DecoratedInput);
    }
  }
  if (options.ancestorThreadId && !options.cursor && !options.archived)
    for (const id of clientState.spawnLinks.madeBy(options.ancestorThreadId)) {
      if (result.data.some((thread: { id: string }) => thread.id === id)) continue;
      const thread = await readListedThread(this, clientState, id);
      if (thread && thread.id === id && !isArchivedThread(thread)) result.data.push(thread);
    }
  await internal_loadWorkflowTitles.call(this, clientState, result.data);
  await internal_settleWorking.call(this, clientState, result.data);
  await Promise.all(result.data.map((thread: DecoratedInput) => recordedAgentModel(thread)));
  // Auto-review's reviewer works in threads of its own; they are not the user's chats.
  const data = result.data
    .filter(
      (thread: ListedThread) =>
        subAgentSource(thread.source)?.other !== "guardian" && (includeAgentRuns || !isAgentRun(thread)),
    )
    .map((thread: ListedThread) => internal_decorate.call(this, clientState, thread));
  // Follow working agents live: only subscribers receive their items, approvals and deltas.
  if (!options.archived)
    for (const thread of data)
      if (
        thread.status?.type === "active" &&
        !clientState.owned.has(thread.id) &&
        !clientState.endedNodes.has(thread.id)
      )
        void internal_attach.call(this, clientState, thread.id, thread).catch(() => {});
  return { ...result, data };
}

/** 3 Nov: after an engine hand-over a chat stayed listed as working with no turn in progress, which hid Edit and
 * Rewind until it was stopped by hand. A chat listed as working counts as working only while a turn is in progress. */
async function internal_settleWorking(this: DesktopClient, clientState: ClientState, threads: ListedThread[]) {
  await Promise.all(
    threads
      .filter(thread => thread.status?.type === "active")
      .map(async thread => {
        const page = await internal_rpc(this, clientState, "thread/turns/list", {
          threadId: thread.id,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        }).catch(() => null);
        thread.status = settledStatus(thread.status, page?.data);
      }),
  );
}

export async function impl_listArchivedThreads(
  this: DesktopClient,
  clientState: ClientState,
  options: ArchiveOptions = {},
) {
  return clientState.archiveHistory.page(options, page => this.listThreads(page));
}

/** Rejoins without model, policy, history or workspace changes. Desktop MCP follows cold resumes;
 * the engine preserves the configuration of threads still loaded by another client. */
export function internal_attach(
  this: DesktopClient,
  clientState: ClientState,
  id: unknown,
  knownThread: unknown = null,
): Promise<import("./client-wire.mts").RpcResponse<"thread/read"> | null> {
  id = threadId(id);
  if (clientState.owned.has(id) && !clientState.attaching.has(id)) return Promise.resolve(null);
  const existing = clientState.attaching.get(id);
  if (existing) return existing;
  clientState.owned.add(id);
  const attempt = (async () => {
    const thread =
      (knownThread as DecoratedInput | null) ??
      (await internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: false })).thread;
    if (!thread || thread.id !== id) throw new BridgeError("Elpis returned another thread", 502);
    if (
      thread.canAcceptDirectInput === false ||
      (thread.status?.type !== "active" && !internal_decorate.call(this, clientState, thread).desktopAccess.writable)
    ) {
      if (thread.status?.type !== "active") {
        clientState.owned.delete(id);
        return { thread };
      }
      try {
        return await internal_rpc(this, clientState, "thread/subscribe", { threadId: id, includeTurns: false });
      } catch (error) {
        const current = await internal_rpc(this, clientState, "thread/read", {
          threadId: id,
          includeTurns: false,
        }).catch(() => null);
        if (current?.thread?.id === id && current.thread.status?.type !== "active") {
          clientState.owned.delete(id);
          return current;
        }
        throw error;
      }
    }
    return internal_rpc(this, clientState, "thread/resume", {
      threadId: id,
      excludeTurns: true,
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "summary" },
      ...internal_browserOptions.call(this, clientState, id as string),
    });
  })()
    .then(result => {
      if (result.thread?.id !== id) throw new BridgeError("Elpis resumed another conversation", 502);
      if (result.followingLive === false) clientState.historyOnly.add(id);
      else clientState.historyOnly.delete(id);
      return result;
    })
    .catch(error => {
      internal_forgetSubscription.call(this, clientState, id);
      throw error;
    })
    .finally(() => {
      if (clientState.attaching.get(id) === attempt) clientState.attaching.delete(id);
    });
  clientState.attaching.set(id, attempt);
  return attempt;
}

export function internal_forgetSubscription(this: DesktopClient, clientState: ClientState, id: unknown) {
  clientState.owned.delete(id);
  clientState.historyOnly.delete(id);
  for (const [key, approval] of clientState.approvals)
    if (approval.ownerThreadId === id || approval.params.threadId === id) {
      clientState.approvals.delete(key);
      this.emit("event", { type: "approvalResolved", data: { id: key } });
    }
}

/** Once background work is idle, release this client's subscription so the engine's
 * existing idle-unload path can discard its history and tool servers. */
export async function internal_releaseIdle(this: DesktopClient, clientState: ClientState, id: unknown) {
  const retained = () =>
    clientState.closed ||
    clientState.disposed ||
    id === clientState.opened ||
    !clientState.owned.has(id) ||
    clientState.attaching.has(id) ||
    clientState.mutating.has(id) ||
    clientState.side.has(id) ||
    clientState.interviewThreads.has(id) ||
    [...clientState.approvals.values()].some(
      approval => approval.ownerThreadId === id || approval.params.threadId === id,
    );
  if (retained()) return;
  const { thread } = await internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: false }).catch(
    () => ({ thread: undefined }),
  );
  if (!thread || thread.status?.type !== "idle" || retained()) return;
  // Forget before sending: a simultaneous reopen must attach again, in order after this unsubscribe.
  internal_forgetSubscription.call(this, clientState, id);
  try {
    await internal_rpc(this, clientState, "thread/unsubscribe", { threadId: id });
    if (!clientState.owned.has(id)) {
      clientState.context.delete(id);
      if (typeof thread.path === "string") {
        clientState.restored.delete(thread.path);
        clientState.shares.delete(thread.path);
        clientState.turnModels.delete(thread.path);
      }
    }
  } catch {
    if (!clientState.closed && !clientState.disposed) clientState.owned.add(id);
  }
}

/** Read current native metadata without resuming a chat or loading its conversation. */
export async function impl_readThreadMetadata(this: DesktopClient, clientState: ClientState, id?: unknown) {
  threadId(id);
  const { thread } = await internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: false });
  if (thread?.id !== id) throw new BridgeError("Elpis returned another thread", 502);
  await internal_loadWorkflowTitles.call(this, clientState, [thread]);
  await internal_settleWorking.call(this, clientState, [thread]);
  await recordedAgentModel(thread);
  return internal_decorate.call(this, clientState, {
    ...thread,
    archived: isArchivedThread(thread) || !!(await clientState.archiveHistory.read(threadId(id))),
  });
}

export async function impl_readThread(
  this: DesktopClient,
  clientState: ClientState,
  id?: unknown,
  input: unknown = {},
) {
  const options = object(input, ["cursor", "limit"]) as { cursor?: string | undefined; limit?: number | undefined };
  const revision = clientState.turnRevisions.get(id);
  const thread = await this.readThreadMetadata(id);
  if (clientState.interviewThreads.has(id)) {
    const start = options.cursor
      ? Number(options.cursor.startsWith(WHOLE_TURNS) ? options.cursor.slice(WHOLE_TURNS.length) : NaN)
      : 0;
    if (!Number.isSafeInteger(start) || start < 0) throw new BridgeError("Invalid cursor");
    const saved = await internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: true });
    const turns = interviewTurns(saved.thread?.turns ?? []);
    const entries = turns.flatMap(turn => turn.items.map(item => ({ turnId: turn.id, item }))).reverse();
    const end = start + (options.limit ?? 30);
    return {
      thread,
      data: await internal_withTurnModels(clientState, thread.path, entries.slice(start, end), !!options.cursor),
      nextCursor: end < entries.length ? `${WHOLE_TURNS}${end}` : null,
    };
  }
  const items = await internal_itemsPage.call(this, clientState, {
    threadId: id,
    cursor: options.cursor,
    limit: options.limit ?? 30,
    sortDirection: "desc",
  });
  // A missed renderer event must not leave its Stop/Working state behind the saved
  // conversation. A newer live turn always takes precedence over this read.
  if (
    thread.model?.startsWith("claude/") &&
    thread.status?.type === "idle" &&
    clientState.turnRevisions.get(id) === revision
  ) {
    this.emit("event", {
      type: "message",
      data: { method: "thread/status/changed", params: { threadId: id, status: thread.status } },
    });
  }
  const data = clientState.chatHistory.merge(thread.id, items);
  return { thread, ...items, data: await internal_withTurnModels(clientState, thread.path, data, !!options.cursor) };
}

export async function impl_readPrompts(this: DesktopClient, _clientState: ClientState, id?: unknown) {
  threadId(id);
  const prompts = new Map(),
    replies = new Map(),
    cursors = new Set();
  let cursor;
  do {
    const page = await this.readThread(id, cursor ? { cursor, limit: 100 } : { limit: 100 });
    for (const { turnId, item } of page.data) {
      if (typeof turnId !== "string") continue;
      if (item?.type === "userMessage" && !isVoiceHandoff(item)) {
        const text = Array.isArray(item.content)
          ? item.content
              .flatMap(part =>
                typeof part !== "string" && part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
              )
              .join("\n")
          : "";
        prompts.set(turnId, { itemId: item.id, text: Array.from(text.trim()).slice(0, 200).join("") });
      } else if (item?.type === "agentMessage") {
        const text =
          typeof item.text === "string"
            ? item.text
            : Array.isArray(item.content)
              ? item.content
                  .flatMap(part =>
                    typeof part !== "string" && part?.type === "text" && typeof part.text === "string"
                      ? [part.text]
                      : [],
                  )
                  .join("\n")
              : "";
        if (text.trim()) replies.set(turnId, Array.from(text.trim()).slice(0, 600).join(""));
      }
    }
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) throw new BridgeError("Repeated history cursor", 502);
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return {
    data: [...prompts].reverse().map(([turnId, prompt]) => ({ turnId, ...prompt, reply: replies.get(turnId) ?? "" })),
  };
}

/** One page of a chat's items. A chat Elpis keeps only as whole turns (older history, or a new chat before its
 * first message is recorded) has no item pages: the engine answers -32601, and the TUI then reads whole turns
 * (its LegacyOnly history). So does this: the page is cut from thread/read's turns, behind a cursor of its own. */
export async function internal_itemsPage(
  this: DesktopClient,
  clientState: ClientState,
  params: {
    threadId: unknown;
    turnId?: unknown;
    cursor?: string | undefined;
    limit?: number | undefined;
    sortDirection?: string | undefined;
  },
) {
  const own = typeof params.cursor === "string" && params.cursor.startsWith(WHOLE_TURNS);
  if (!own) {
    try {
      const page = await internal_rpc(this, clientState, "thread/items/list", params);
      return Array.isArray(page?.data) ? { ...page, data: page.data.filter(notImportMarker) } : page;
    } catch (error) {
      if ((error as { code?: unknown }).code !== -32601) throw error;
    }
  }
  const start = own ? Number((params.cursor as string).slice(WHOLE_TURNS.length)) : 0;
  if (!Number.isSafeInteger(start) || start < 0) throw new BridgeError("Invalid cursor");
  let turns: NonNullable<DecoratedInput["turns"]>;
  try {
    turns =
      (await internal_rpc(this, clientState, "thread/read", { threadId: params.threadId, includeTurns: true })).thread
        ?.turns ?? [];
  } catch (error) {
    if (/is not materialized yet/.test((error as { engineMessage?: string }).engineMessage ?? "")) turns = [];
    else throw error;
  }
  const entries = turns
    .filter((turn: { id?: unknown }) => !params.turnId || turn.id === params.turnId)
    .flatMap(turn => (Array.isArray(turn.items) ? turn.items : []).map(item => ({ turnId: turn.id, item })))
    .filter(notImportMarker);
  if (params.sortDirection === "desc") entries.reverse();
  const end = start + (params.limit ?? 30);
  return {
    data: entries.slice(start, end),
    nextCursor: end < entries.length ? `${WHOLE_TURNS}${end}` : null,
    backwardsCursor: null,
  };
}

export async function impl_media(
  this: DesktopClient,
  clientState: ClientState,
  id?: unknown,
  turn?: unknown,
  itemId?: unknown,
  inputIndex?: unknown,
) {
  threadId(id);
  text(turn, "turn ID", 200);
  text(itemId, "item ID", 200);
  if (typeof inputIndex !== "number" || !Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex > 100)
    throw new BridgeError("Invalid media index");
  const cursors = new Set();
  let cursor: string | null | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const page = await internal_itemsPage.call(this, clientState, {
      threadId: id,
      turnId: turn,
      limit: 100,
      sortDirection: "asc",
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(page?.data) || page.data.some((entry: { turnId?: unknown } | null) => entry?.turnId !== turn))
      throw new BridgeError("Could not verify recorded media", 502);
    const entry = page.data.find((entry: { item?: { id?: unknown } }) => entry.item?.id === itemId);
    if (entry) {
      // An image the agent viewed is its one picture.
      if (entry.item.type === "imageView" && inputIndex === 0 && typeof entry.item.path === "string")
        return recordedMedia({ type: "localImage", path: entry.item.path });
      if (entry.item.type !== "userMessage" || !Array.isArray(entry.item.content))
        throw new BridgeError("No recorded media here", 404);
      const part = entry.item.content[inputIndex];
      return recordedMedia(typeof part === "string" ? undefined : part);
    }
    if (page.nextCursor === null) break;
    if (typeof page.nextCursor !== "string" || !page.nextCursor || cursors.has(page.nextCursor))
      throw new BridgeError("Could not verify recorded media", 502);
    cursor = page.nextCursor;
    cursors.add(cursor);
  }
  throw new BridgeError("Recorded media was not found", 404);
}
