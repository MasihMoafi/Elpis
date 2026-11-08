import { rpcResult, type RpcResponse } from "./client-wire.mts";
import { BridgeError, threadId } from "./validate.mts";
import { randomUUID } from "node:crypto";
import { DOWNLOADS, readRpc } from "./client-protocol.mts";
import type { ClientState } from "./client-state.mts";
export function internal_browserOptions(this: unknown, clientState: Pick<ClientState, "browserConfig">, id: string) {
  const config = clientState.browserConfig
    ? clientState.browserConfig.forSession
      ? clientState.browserConfig.forSession(id)
      : clientState.browserConfig
    : {};
  return Object.keys(config).length ? { config } : {};
}
export function internal_rpc<M extends string>(
  client: { readonly timeoutMs: number },
  clientState: Pick<ClientState, "closed" | "pending" | "socket">,
  method: M,
  params?: unknown,
): Promise<RpcResponse<M>> {
  if (clientState.closed) return Promise.reject(new BridgeError("Elpis is disconnected", 503));
  const id = `desktop-${randomUUID()}`,
    reading = readRpc(method, params);
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        clientState.pending.delete(id);
        reject(
          new BridgeError(
            reading
              ? "Elpis timed out while reading. Reload the view to try again."
              : "Elpis request timed out; its outcome is unknown. Refresh before retrying.",
            504,
          ),
        );
      },
      DOWNLOADS.has(method) ? Math.max(client.timeoutMs, 600000) : client.timeoutMs,
    );
    clientState.pending.set(id, { resolve, reject, timer, method, reading });
    try {
      clientState.socket.send(JSON.stringify({ id, method, params }));
    } catch {
      clearTimeout(timer);
      clientState.pending.delete(id);
      reject(new BridgeError("Could not send request to Elpis", 503));
    }
  }).then(value => rpcResult(method, value));
}

/** The merged configuration with the organization's policy; policy is null when it could not be read. */
export function internal_readConfigAndPolicy(client: Parameters<typeof internal_rpc>[0], clientState: ClientState) {
  return Promise.all([
    internal_rpc(client, clientState, "config/read", { includeLayers: true }),
    internal_rpc(client, clientState, "configRequirements/read", {}).catch(() => null),
  ]);
}

/** Native TOML errors can contain submitted values, so only the status and the caller's safe message survive. */
export async function internal_writeConfig(
  client: Parameters<typeof internal_rpc>[0],
  clientState: ClientState,
  edits: unknown[],
  expectedVersion: unknown,
  failed: string,
) {
  try {
    await internal_rpc(client, clientState, "config/batchWrite", {
      edits,
      expectedVersion,
      reloadUserConfig: true,
    } as never);
  } catch (error) {
    const failure = error as { status?: number };
    if (failure.status === 409)
      throw new BridgeError("Settings changed in another client. Reload settings before saving again.", 409);
    throw new BridgeError(failed, failure.status ?? 502);
  }
}

/** Forks a chat with its browser session; the session is released if the fork fails, and the new chat is owned here. */
export async function internal_forkOwned(
  client: Parameters<typeof internal_rpc>[0],
  clientState: ClientState,
  browserSession: string,
  params: object,
) {
  const fork = await internal_rpc(client, clientState, "thread/fork", {
    ...params,
    ...internal_browserOptions.call(client, clientState, browserSession),
  } as never).catch(error => {
    clientState.browserConfig?.close?.(browserSession);
    throw error;
  });
  threadId(fork.thread?.id);
  clientState.browserConfig?.bind?.(browserSession, fork.thread.id);
  clientState.owned.add(fork.thread.id);
  return fork;
}
