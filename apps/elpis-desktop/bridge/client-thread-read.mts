import { BridgeError, object, text, threadId } from "./validate.mts";
import { interviewTurns } from "./love-interview.mts";
import { recordedMedia } from "./attachments.mts";
import { internal_browserOptions, internal_rpc } from "./client-rpc.mts";
import { internal_withTurnModels } from "./client-rollout-cache.mts";
import type { DesktopClient } from "./client.mts";
import type { ClientState } from "./client-state.mts";
import {
  isVoiceHandoff,
  WHOLE_TURNS,
  recordedAgentModel,
  notImportMarker,
  isArchivedThread,
  internal_loadWorkflowTitles,
  internal_decorate,
  internal_settleWorking,
} from "./client-thread-decorate.mts";
import type { DecoratedInput } from "./client-thread-decorate.mts";

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
