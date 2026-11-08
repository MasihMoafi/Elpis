import { SOURCE_KINDS, CHAT_SOURCE_KINDS, SEARCH_SCAN_PAGES, recordedAgentModel, subAgentSource, isArchivedThread, internal_loadWorkflowTitles, internal_decorate, internal_settleWorking } from "./client-thread-decorate.mts";
import type { ThreadListOptions, ListedThread, DecoratedInput } from "./client-thread-decorate.mts";
export { isVoiceHandoff, SOURCE_KINDS, WHOLE_TURNS, recordedAgentModel, notImportMarker, subAgentSource, isArchivedThread, settledStatus, internal_loadWorkflowTitles, internal_learnSpawn, internal_decorate, internal_settleWorking } from "./client-thread-decorate.mts";
export type { ThreadListOptions, ListedThread, EngineItem, EngineTurn, DecoratedInput } from "./client-thread-decorate.mts";
import { internal_attach, internal_forgetSubscription } from "./client-thread-read.mts";
export { internal_attach, internal_forgetSubscription, internal_releaseIdle, impl_readThreadMetadata, impl_readThread, impl_readPrompts, internal_itemsPage, impl_media } from "./client-thread-read.mts";
import { isAgentRun } from "../lib/agent-runs.mts";
import { BridgeError, object, text, threadId } from "./validate.mts";

import { internal_rpc } from "./client-rpc.mts";

import type { DesktopClient } from "./client.mts";
import type { ArchiveOptions } from "./client-archive-history.mts";
import type { ClientState } from "./client-state.mts";

function readListedThread(client: Parameters<typeof internal_rpc>[0], clientState: ClientState, id: string) {
  return internal_rpc(client, clientState, "thread/read", { threadId: id, includeTurns: false }).then(
    result => result.thread,
    () => undefined,
  );
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

export async function impl_listArchivedThreads(
  this: DesktopClient,
  clientState: ClientState,
  options: ArchiveOptions = {},
) {
  return clientState.archiveHistory.page(options, page => this.listThreads(page));
}
