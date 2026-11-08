export { internal_withTurnModels } from "./client-rollout-cache.mts";
import { BridgeError, object, text, threadId } from "./validate.mts";
import {
  CONTEXT_SWITCH_KEYS,
  cacheUse,
  contextLedger,
  contextSwitchesSnapshot,
  restoredTokenUsage,
  rolloutShares,
} from "./elpis-features.mts";
import fs from "node:fs";
import path from "node:path";
import { sessionContextFiles } from "./session-context.mts";
import { BUILT_IN_KEY_PROVIDERS } from "./provider-settings.mts";
import { internal_decorate } from "./client-thread-list.mts";
import { internal_mutate } from "./client-mutation.mts";
import { internal_rpc, internal_writeConfig } from "./client-rpc.mts";
import type { DesktopClient } from "./client.mts";
import type { ClientState } from "./client-state.mts";

/** Context sources and admission use the same engine functions as the TUI Ledger. */
export async function impl_contextFiles(this: DesktopClient, clientState: ClientState, id: unknown) {
  threadId(id);
  return internal_rpc(this, clientState, "thread/contextFiles/list", { threadId: id });
}

export async function impl_goal(this: DesktopClient, clientState: ClientState, id: unknown) {
  threadId(id);
  return internal_rpc(this, clientState, "thread/goal/get", { threadId: id });
}

export async function impl_setGoal(this: DesktopClient, clientState: ClientState, id: unknown, raw: unknown) {
  threadId(id);
  const input = object(raw, ["objective", "clear"]) as { objective?: string; clear?: boolean };
  if (input.clear !== undefined && (input.clear !== true || input.objective !== undefined))
    throw new BridgeError("Choose a goal or clear it");
  if (input.clear !== true) text(input.objective, "goal", 32000);
  return internal_mutate(clientState, id, async () => {
    const { thread } = await internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new BridgeError("Elpis returned another thread", 502);
    if (!internal_decorate.call(this, clientState, thread).desktopAccess.writable)
      throw new BridgeError("Only this agent’s parent can change its goal.", 409);
    return input.clear
      ? internal_rpc(this, clientState, "thread/goal/clear", { threadId: id })
      : internal_rpc(this, clientState, "thread/goal/set", {
          threadId: id,
          objective: (input.objective as string).trim(),
          status: "active",
        });
  });
}

export async function impl_sessionContext(this: DesktopClient, clientState: ClientState, id: unknown) {
  threadId(id);
  const [{ thread }, sources, { goal }] = await Promise.all([
    internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: false }),
    this.contextFiles(id),
    this.goal(id),
  ]);
  if (thread?.id !== id) throw new BridgeError("Elpis returned another thread", 502);
  return {
    ...(await sessionContextFiles(thread, sources.files)),
    ...(sources.note ? { note: sources.note } : {}),
    goal,
    writable: internal_decorate.call(this, clientState, thread).desktopAccess.writable,
  };
}

export async function impl_createSessionIntent(
  this: DesktopClient,
  clientState: ClientState,
  id: unknown,
  input: unknown,
) {
  threadId(id);
  object(input, []);
  return internal_mutate(clientState, id, async () => {
    const { thread } = await internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: false });
    if (thread?.id !== id) throw new BridgeError("Elpis returned another thread", 502);
    if (!internal_decorate.call(this, clientState, thread).desktopAccess.writable)
      throw new BridgeError("Only this agent’s parent can create its session intent.", 409);
    if (typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd))
      throw new BridgeError("Open a project folder first.");
    const file = path.join(await fs.promises.realpath(thread.cwd), "ES.md");
    let handle;
    try {
      handle = await fs.promises.open(file, "wx", 0o600);
      await handle.writeFile("# Session intent\n\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new BridgeError("ES.md already exists. Open it to edit the current intent.", 409);
      throw error;
    } finally {
      await handle?.close();
    }
    return { path: file };
  });
}

export async function impl_setContextFile(this: DesktopClient, clientState: ClientState, id: unknown, raw: unknown) {
  threadId(id);
  const input = object(raw, ["path", "included"]) as { path?: unknown; included?: unknown };
  text(input.path, "context file path");
  if (typeof input.included !== "boolean") throw new BridgeError("Choose included or excluded");
  return internal_rpc(this, clientState, "thread/contextFiles/set", {
    threadId: id,
    path: input.path,
    included: input.included,
  });
}

export async function impl_context(this: DesktopClient, clientState: ClientState, id: unknown) {
  threadId(id);
  const { thread } = await internal_rpc(this, clientState, "thread/read", { threadId: id, includeTurns: false });
  if (thread?.id !== id) throw new BridgeError("Elpis returned another thread", 502);
  const { desktopAccess } = internal_decorate.call(this, clientState, thread);
  const snapshot = clientState.context.get(id) ?? {};
  // Before this connection has live usage, the last usage the chat's rollout recorded (what a cold resume restores).
  const restored = snapshot.tokenUsage ? null : await internal_restoredUsage.call(this, clientState, thread.path);
  const tokenUsage = snapshot.tokenUsage ?? restored;
  // The TUI has the shares only once its own process has seen a request; for a chat this app has not seen run, the saved transcript stands in.
  const saved =
    tokenUsage && !tokenUsage.contextAttribution
      ? await internal_savedShares.call(this, clientState, thread.path)
      : null;
  return {
    threadId: id,
    tokenUsage,
    smartPrune: snapshot.smartPrune ?? null,
    ledger: contextLedger(tokenUsage, saved),
    cache: cacheUse(tokenUsage),
    // The ledger's Compact session, as the terminal's /compact: only a chat that is idle and takes turns here.
    compact:
      thread.status?.type === "active"
        ? { available: false, reason: "Available when Elpis finishes this turn" }
        : desktopAccess.mode === "continue"
          ? { available: false, reason: "Only this agent's parent can compact it" }
          : { available: true },
    availability: {
      tokenUsage: snapshot.tokenUsage ? "live" : restored ? "restored" : "unavailable",
      smartPrune: snapshot.smartPrune ? "live" : "unavailable",
    },
    reason:
      "Live usage comes from events this app connection receives; before them, the last usage the chat's rollout recorded. Until the engine reports its category shares for a request, they are estimated from the chat's saved transcript.",
  };
}

async function internal_savedShares(this: DesktopClient, clientState: ClientState, file: unknown) {
  const stat = typeof file === "string" ? await fs.promises.stat(file).catch(() => null) : null;
  if (!stat?.isFile()) return null;
  const key = `${stat.size}:${stat.mtimeMs}`,
    cached = clientState.shares.get(file);
  if (cached?.key === key) return cached.value;
  const value = await rolloutShares(file);
  clientState.shares.set(file, { key, value });
  return value;
}

async function internal_restoredUsage(this: DesktopClient, clientState: ClientState, file: unknown) {
  const stat = typeof file === "string" ? await fs.promises.stat(file).catch(() => null) : null;
  if (!stat?.isFile()) return null;
  const key = `${stat.size}:${stat.mtimeMs}`,
    cached = clientState.restored.get(file);
  if (cached?.key === key) return cached.value;
  const value = await restoredTokenUsage(file);
  clientState.restored.set(file, { key, value });
  return value;
}

/** The Context Ledger's Smart Prune, Subagents and RAG switches (elpis-features.mts `contextSwitchesSnapshot`). */
export async function impl_contextSwitches(this: DesktopClient, clientState: ClientState) {
  return contextSwitchesSnapshot(await internal_rpc(this, clientState, "config/read", { includeLayers: true }));
}

/** Writes the switches as the TUI ledger does: one config key each, reloaded so open chats use it from their next turn. */
export async function impl_saveContextSwitches(this: DesktopClient, clientState: ClientState, raw: unknown) {
  const input = object(raw, ["version", ...Object.keys(CONTEXT_SWITCH_KEYS)]) as Record<string, unknown>;
  text(input.version, "settings version", 200);
  const current = await this.contextSwitches();
  if (!current.write.available || current.version !== input.version)
    throw new BridgeError("Settings changed in another client. Reload settings before saving again.", 409);
  const edits = [];
  for (const [field, keyPath] of Object.entries(CONTEXT_SWITCH_KEYS)) {
    if (!(field in input)) continue;
    if (typeof input[field] !== "boolean") throw new BridgeError("Turn each switch on or off");
    if (field === "rag" && current.rag === null)
      throw new BridgeError("No rag MCP server is configured. Add one in Settings → MCP servers.", 409);
    edits.push({ keyPath, value: input[field], mergeStrategy: "replace" });
  }
  if (!edits.length) throw new BridgeError("No switch was changed");
  await internal_writeConfig(this, clientState, edits, input.version, "The switch could not be saved. Refresh and try again.");
  if ("rag" in input) await internal_rpc(this, clientState, "config/mcpServer/reload", undefined).catch(() => {});
  return this.contextSwitches();
}

export function internal_model(this: DesktopClient, clientState: ClientState, model: unknown) {
  if (model === undefined) return;
  if (!clientState.models.has(model)) throw new BridgeError("Select a model returned by the current Elpis model list");
  return model;
}

export async function internal_providerModel(
  this: DesktopClient,
  clientState: ClientState,
  model: unknown,
  provider: unknown,
) {
  if (model !== undefined && provider) {
    const current = await this.providerSettings();
    // A custom connection, or the engine's gateway route (e.g. the Anthropic credits), whose models it lists itself.
    // A built-in key provider (OpenRouter, Anthropic, Gemini with a pasted key) is a connection too, though config.toml
    // does not list it (7 Nov, live: Matilda refused an OpenRouter model chosen in her picker).
    if (
      current.providers.some(entry => entry.id === provider && (entry.editable || entry.gateway)) ||
      (typeof provider === "string" && Object.hasOwn(BUILT_IN_KEY_PROVIDERS, provider))
    ) {
      if (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/.test(model))
        throw new BridgeError("Give a model ID supported by this API provider");
      if (/^(claude|agy|antigravity)\//i.test(model))
        throw new BridgeError("Subscription model routes cannot be used with an API provider");
      return model;
    }
  }
  return internal_model.call(this, clientState, model);
}

export async function internal_chatModel(
  this: DesktopClient,
  clientState: ClientState,
  model: unknown,
  provider: unknown,
) {
  // An existing chat can switch to a subscription even if its carrier uses an API provider.
  if (typeof model === "string" && /^(?:claude|agy)\//.test(model))
    return internal_model.call(this, clientState, model);
  return internal_providerModel.call(this, clientState, model, provider);
}
