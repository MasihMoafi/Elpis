import { BridgeError, object, threadId } from "./validate.mts";
import {
  NOT_A_REPOSITORY,
  changedFiles,
  currentBranch,
  discardFile,
  fileDiff,
  repositoryHealth,
  reviewChoices,
  workingDiff,
} from "./git.mts";
import { recordedChanges } from "./recorded-changes.mts";

import { internal_attach, internal_itemsPage } from "./client-thread-list.mts";
import { internal_rpc } from "./client-rpc.mts";
import type { DesktopClient } from "./client.mts";
import type { ClientState } from "./client-state.mts";

/** Read-only Git facts about the chat's folder: `review` is the /review presets (branches, commits), `diff` the /diff text,
 * `changes` the review surface's file list, `file` one of those files' diff (`file` names it) and `branch` the branch
 * checked out, for the chat's branch chip. */
export async function impl_git(
  this: DesktopClient,
  clientState: ClientState,
  id: unknown,
  view: unknown,
  file?: unknown,
) {
  threadId(id);
  if (typeof view !== "string" || !["review", "diff", "changes", "file", "branch", "health"].includes(view))
    throw new BridgeError("Choose a Git view: review, diff, changes, file, branch or health");
  const cwd = await internal_folderOf.call(this, clientState, id);
  try {
    return await (view === "review"
      ? reviewChoices(cwd)
      : view === "changes"
        ? changedFiles(cwd)
        : view === "file"
          ? fileDiff(cwd, file)
          : view === "branch"
            ? currentBranch(cwd)
            : view === "health"
              ? repositoryHealth(cwd)
              : workingDiff(cwd));
  } catch (error) {
    // Outside Git, the changes are the edits this chat recorded (bridge/recorded-changes.mts); /review needs Git.
    if ((error as Error).message !== NOT_A_REPOSITORY || !["changes", "file", "diff"].includes(view)) throw error;
    const recorded = recordedChanges(
      cwd!,
      (await internal_chatItems.call(this, clientState, id)) as Parameters<typeof recordedChanges>[1],
    );
    return view === "changes" ? recorded.changes : view === "file" ? recorded.file(file) : recorded.diff();
  }
}

/** Every item of a chat, oldest first, at most 50 pages of 200. */
async function internal_chatItems(this: DesktopClient, clientState: ClientState, id: unknown) {
  // A saved session can return empty item pages until the engine has loaded its turns.
  await internal_attach.call(this, clientState, id);
  const items = [],
    seen = new Set();
  let cursor: string | null | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await internal_itemsPage.call(this, clientState, {
      threadId: id,
      limit: 200,
      sortDirection: "asc",
      ...(cursor ? { cursor } : {}),
    });
    if (!Array.isArray(result?.data)) throw new BridgeError("Could not read the recorded edits.", 502);
    items.push(...result.data.map((entry: { item?: unknown } | null | undefined) => entry?.item).filter(Boolean));
    cursor = result?.nextCursor;
    if (!cursor) return items;
    if (seen.has(cursor)) throw new BridgeError("Repeated recorded edits cursor.", 502);
    seen.add(cursor);
  }
  throw new BridgeError("This chat has more recorded edits than this view can read.", 409);
}

/** The review surface's only write: throw one changed file away (the window asks first). */
export async function impl_discardChange(this: DesktopClient, clientState: ClientState, id: unknown, input: unknown) {
  threadId(id);
  const body = object(input, ["action", "path"]) as { action?: unknown; path?: unknown };
  if (body.action !== "discard") throw new BridgeError("Choose a Git action: discard");
  return discardFile(await internal_folderOf.call(this, clientState, id), body.path);
}

export async function internal_folderOf(this: DesktopClient, clientState: ClientState, id: unknown) {
  const { thread } = await internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: false });
  if (thread?.id !== id) throw new BridgeError("Elpis returned another thread", 502);
  return thread.cwd;
}
