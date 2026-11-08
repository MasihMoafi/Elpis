import { rpcResult, type RpcResponse } from './client-wire.mts';
import { BridgeError } from './validate.mts';
import { randomUUID } from 'node:crypto';
import { DOWNLOADS, readRpc } from './client-protocol.mts';
import type { ClientState } from './client-state.mts';
export function internal_browserOptions(this: unknown, clientState: Pick<ClientState, 'browserConfig'>, id: string) {
    const config = clientState.browserConfig ? (clientState.browserConfig.forSession ? clientState.browserConfig.forSession(id) : clientState.browserConfig) : {};
    return Object.keys(config).length ? { config } : {};
}
export function internal_rpc<M extends string>(client: { readonly timeoutMs: number }, clientState: Pick<ClientState, 'closed' | 'pending' | 'socket'>, method: M, params?: unknown): Promise<RpcResponse<M>> {
    if (clientState.closed)
        return Promise.reject(new BridgeError('Elpis is disconnected', 503));
    const id = `desktop-${randomUUID()}`, reading = readRpc(method, params);
    return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
            clientState.pending.delete(id);
            reject(new BridgeError(reading ? 'Elpis timed out while reading. Reload the view to try again.' : 'Elpis request timed out; its outcome is unknown. Refresh before retrying.', 504));
        }, DOWNLOADS.has(method) ? Math.max(client.timeoutMs, 600000) : client.timeoutMs);
        clientState.pending.set(id, { resolve, reject, timer, method, reading });
        try {
            clientState.socket.send(JSON.stringify({ id, method, params }));
        }
        catch {
            clearTimeout(timer);
            clientState.pending.delete(id);
            reject(new BridgeError('Could not send request to Elpis', 503));
        }
    }).then(value => rpcResult(method, value));
}
