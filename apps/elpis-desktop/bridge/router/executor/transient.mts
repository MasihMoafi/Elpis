// Ported from dsh-superagent (MIT), src/executor/dsh.ts
/**
 * Internal error thrown when a ticket's workspace prepare command fails during launch.
 * DshExecutor catches it to mark the ticket failed immediately rather than retrying automatically, because an existing directory counts as prepared and an automatic retry would treat whatever a failed prepare command left behind in the directory as a prepared workspace.
 */
export const PASSING = new RegExp(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR', 'socket hang up', 'fetch failed',
    'network error', 'overloaded', 'rate limit', '\\b(?:408|429|50[0-4])\\b'].join('|'), 'i');
/**
 * True when an error represents a transient network or model-provider failure: an HTTP 408, 429, or 5xx status, or a
 * connection that was refused, reset, timed out, or could not resolve its host.
 */
export function transient(error: unknown): boolean {
    const status = (error as {
        status?: unknown;
    } | undefined)?.status;
    if (typeof status === 'number')
        return status === 408 || status === 429 || status >= 500;
    const code = (error as {
        code?: unknown;
    } | undefined)?.code;
    const text = error instanceof Error ? `${error.name} ${error.message} ${typeof code === 'string' || typeof code === 'number' ? code : ''}` : String(error);
    return PASSING.test(text);
}
