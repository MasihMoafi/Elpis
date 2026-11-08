import { BridgeError, object, text, threadId } from "./validate.mts";
import { internal_rpc } from "./client-rpc.mts";
import { internal_current } from "./client-rewind.mts";
import type { DesktopClient } from "./client.mts";
import type { ClientState } from "./client-state.mts";
import { rpcResult } from "./client-wire.mts";

/** A side question inherits the current history but is never materialized as a saved session. */
export async function impl_createSideChat(this: DesktopClient, clientState: ClientState, id?: unknown, body?: unknown) {
  object(body, []);
  const thread = await internal_current.call(this, clientState, id);
  const result = await internal_rpc(this, clientState, "thread/fork", {
    threadId: id,
    ephemeral: true,
    excludeTurns: true,
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.modelProvider ? { modelProvider: thread.modelProvider } : {}),
    approvalPolicy: "never",
    permissions: ":danger-full-access",
  });
  const sideId = threadId(result.thread?.id);
  clientState.side.add(sideId);
  if (result.thread.ephemeral !== true) {
    try {
      await this.sideRpc("thread/delete", { threadId: sideId });
    } finally {
      await this.sideRpc("thread/unsubscribe", { threadId: sideId }).catch(() => {});
    }
    throw new BridgeError("The runtime did not create an ephemeral side chat. Update Elpis and try again.", 502);
  }
  clientState.sideChats.set(sideId, { turnId: null, starting: false, pending: null, closing: false });
  return { threadId: sideId };
}

export async function impl_sendSideChat(this: DesktopClient, clientState: ClientState, id?: unknown, raw?: unknown) {
  const body = object(raw, ["text"]) as { text?: unknown };
  const prompt = text(body.text, "side question"),
    chat = clientState.sideChats.get(threadId(id));
  if (!chat) throw new BridgeError("Side chat is no longer available.", 404);
  if (chat.starting || chat.pending || chat.turnId || chat.closing)
    throw new BridgeError("A side reply is already running or closing.", 409);
  chat.starting = true;
  try {
    chat.pending = this.sideRpc("turn/start", {
      threadId: id,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    const result = rpcResult("turn/start", await chat.pending);
    // Completion can arrive before the acknowledgement; do not revive an already completed turn.
    if (chat.starting) chat.turnId = result.turn?.id;
    return result;
  } finally {
    chat.starting = false;
    chat.pending = null;
  }
}

export async function impl_closeSideChat(this: DesktopClient, clientState: ClientState, id?: unknown, body?: unknown) {
  object(body, []);
  const chat = clientState.sideChats.get(threadId(id));
  if (!chat) throw new BridgeError("Side chat is no longer available.", 404);
  chat.closing = true;
  if (chat.pending) await chat.pending.catch(() => {});
  try {
    if (chat.turnId) await this.sideRpc("turn/interrupt", { threadId: id, turnId: chat.turnId });
  } finally {
    await this.sideRpc("thread/unsubscribe", { threadId: id });
  }
  clientState.sideChats.delete(id);
  return { closed: true };
}

/** The Claude Code chats the engine would import: its own detection (the last 30 days, up to 50, none already imported). */
export async function impl_externalSessions(this: DesktopClient, clientState: ClientState) {
  const result = await internal_rpc(this, clientState, "externalAgentConfig/detect", {
    includeHome: true,
    source: "claude",
  });
  return (result.items ?? [])
    .filter(item => item.itemType === "SESSIONS")
    .flatMap(item => (item.details?.sessions ?? []).map(({ path, cwd, title }) => ({ path, cwd, title })));
}

/** Registers a Codex rollout already copied into Elpis's sessions folder, so it lists, opens and forks like a chat Elpis made. */
export async function impl_registerRollout(this: DesktopClient, clientState: ClientState, rollout?: unknown) {
  text(rollout, "rollout", 4096);
  return (await internal_rpc(this, clientState, "thread/register", { path: rollout })).thread;
}

/** Imports Claude Code chats as Elpis chats and resolves when the engine has finished them: { imported, skipped: [reasons] }. */
export async function impl_importExternalSessions(this: DesktopClient, clientState: ClientState, sessions?: unknown) {
  if (!Array.isArray(sessions) || !sessions.length) return { imported: 0, skipped: [] };
  const { importId } = await internal_rpc(this, clientState, "externalAgentConfig/import", {
    source: "claude",
    migrationItems: [{ itemType: "SESSIONS", description: "Claude Code chats", cwd: null, details: { sessions } }],
  });
  for (let wait = 0; wait < 600; wait++) {
    const { data = [] } = await internal_rpc(this, clientState, "externalAgentConfig/import/readHistories");
    const done = data.find((item: { importId?: unknown }) => item.importId === importId);
    if (done)
      return {
        imported: done.successes.length,
        skipped: done.failures.map((failure: { message?: unknown }) => failure.message),
      };
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new BridgeError(
    "The import is taking longer than expected. It carries on in the background; look again in a minute.",
    504,
  );
}
