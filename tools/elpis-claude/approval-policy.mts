import type { AskForApproval } from '../../codex-rs/app-server-protocol/schema/typescript/v2/AskForApproval.ts';
import { wireObject } from './bridge-wire.mts';
/** The native generated union owns the wire contract. */
export function isApprovalPolicy(value: unknown): value is AskForApproval {
    if (typeof value === 'string')
        return ['untrusted', 'on-request', 'never'].includes(value);
    if (!wireObject(value) || !wireObject(value.granular))
        return false;
    const { sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations } = value.granular;
    return [sandbox_approval, rules, skill_approval, request_permissions, mcp_elicitations].every(flag => typeof flag === 'boolean');
}
