import { AGENT_RUN_NOTICE, agentParentId, isAgentRun } from "../lib/agent-runs.mts";
import { BridgeError, threadId } from "./validate.mts";
import { createdThread } from "./spawn-links.mts";
import { interviewTurns, legacyInterview } from "./love-interview.mts";
import { rolloutAgentModel } from "./elpis-features.mts";
import fs from "node:fs/promises";
import path from "node:path";
import { internal_rpc } from "./client-rpc.mts";
import voiceHandoff from "./voice-handoff.cts";
import type { DesktopClient } from "./client.mts";
import type { ClientState } from "./client-state.mts";

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

export const CHAT_SOURCE_KINDS = ["cli", "vscode", "appServer", "unknown"];

/** Search reads at most this many pages of 100 chats for names (2,000 chats). */
export const SEARCH_SCAN_PAGES = 20;

/** The cursor of a page cut from whole turns (see #itemsPage); the engine's own cursors never start with it. */
export const WHOLE_TURNS = "whole-turns:";

/** The engine's Claude Code import ends the last turn with this agent message, after the chat's real last reply
 * (codex-rs/external-agent-migration, EXTERNAL_SESSION_IMPORTED_MARKER). It is a note for the engine, not a reply. */
export const IMPORT_MARKER = "<EXTERNAL SESSION IMPORTED>";

export const agentModels = new Map<string, { key: string; value: Awaited<ReturnType<typeof rolloutAgentModel>> }>();

export async function recordedAgentModel(thread: DecoratedInput) {
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

export const notImportMarker = (entry: unknown) => {
  const value = entry as { item?: { type?: unknown; text?: unknown } } | null | undefined;
  return !(value?.item?.type === "agentMessage" && value.item.text === IMPORT_MARKER);
};

export type ThreadSource =
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

export const isArchivedThread = (thread: Pick<DecoratedInput, "archived" | "path">) =>
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

export async function internal_loadWorkflowTitles(this: DesktopClient, clientState: ClientState, threads: ListedThread[]) {
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

/** 3 Nov: after an engine hand-over a chat stayed listed as working with no turn in progress, which hid Edit and
 * Rewind until it was stopped by hand. A chat listed as working counts as working only while a turn is in progress. */
export async function internal_settleWorking(this: DesktopClient, clientState: ClientState, threads: ListedThread[]) {
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
