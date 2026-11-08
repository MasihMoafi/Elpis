// Ported from dsh-superagent (MIT), src/executor/dsh.ts
import { mkdir, rmdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Ticket } from '../core/index.mts';
import { runAsWorker, verifyDirectory } from '../infra/environment.mts';
import type { ExecutorHost } from './dsh.mts';
export class PrepareFailed extends Error {
}
const PREPARE_TIMEOUT_MS = 10 * 60000;
export async function prepareDirectory(host: Pick<ExecutorHost, 'store' | 'context' | 'environment' | 'processEnvironment' | 'lifetime'>, ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? '';
    await mkdir(dirname(directory), { recursive: true });
    const command = host.store.settings().executor.prepare.trim();
    const env = { ...host.processEnvironment?.(), ...Object.fromEntries(host.environment(ticket).map(variable => [variable.key, variable.value])) };
    // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
    const signal = AbortSignal.any([host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)]);
    if (command)
        await runAsWorker(host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
            .catch(async (error: unknown) => {
            // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
            await rmdir(directory).catch(() => { });
            throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    await mkdir(directory, { recursive: true });
    await verifyDirectory(directory, host.context.subprocess, host.lifetime);
}
