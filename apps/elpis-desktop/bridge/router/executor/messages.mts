// Ported from dsh-superagent (MIT), src/executor/dsh.ts
import { join } from 'node:path';
import { key, threadKey } from '../core/index.mts';
import type { AssessmentOutcome, Execution, Mandate, PolicyEffect, Ticket, TicketInput, Trigger } from '../core/index.mts';
import type { Settings } from './settings.mts';
import type { ExecutorStore as Store } from './store.mts';
import { executionRoot } from './execution-environment.mts';
import { WorktreeNameSchema } from '../worktree-name.mts';
/** Returns the worker session ID (`worker-<ticketId>`) for a ticket. */
export const workerSessionId = (ticketId: string): string => `worker-${ticketId}`;
/** Returns the ticket ID for a worker session ID (`worker-<ticketId>`), or undefined for non-worker sessions. */
export const ticketOfSession = (sessionId: string): string | undefined => sessionId.startsWith('worker-') ? sessionId.slice('worker-'.length) : undefined;
/** Appends a stable 12-character ticket ID suffix to a validated English worktree name. */
export const ticketWorktreeName = (name: string, id: string): string => `${WorktreeNameSchema.parse(name)}-${id.slice(0, 12)}`;
/** Looks up a ticket's origin trigger in Store. */
export const sourceTrigger = (host: {
    store: Pick<Store, 'triggers'>;
}, ticket: Ticket): Trigger | undefined => host.store.triggers.get(ticket.origin.triggerId);
/**
 * Returns additional system-prompt mandate instructions for a worker beyond the request: for work accepted proactively under
 * rules (`strength === 'inferred'`), restricts authorization to small internal changes within the rule scope; returns `''` for explicit requests.
 */
export function mandateInstructions(mandate: Pick<Mandate, 'strength'>): string {
    return mandate.strength === 'inferred' ? 'This ticket has limited proactive authorization. Independently verify that it is a small change '
        + 'internal to one module within the accepted rule scope. If it requires public-interface or behavior changes, new interaction, product '
        + 'decisions or clarification, stop and report dropped; do not expand scope.' : '';
}
/** Builds a newly accepted ticket's Execution metadata: its worktree name, workspace directory, and assignment text. */
export function ticketExecution(ticket: Ticket, outcome: Extract<AssessmentOutcome, {
    kind: 'accept';
}>, settings: Settings, stateDir: string): Execution {
    const name = ticketWorktreeName(outcome.name ?? '', ticket.id);
    const note = outcome.note ? `\nRouting note (not the source request): ${outcome.note}` : '';
    const ruleIds = ticket.mandate.basis.rules;
    const rules = settings.policy.rules.filter(rule => ruleIds?.includes(rule.id))
        .map(rule => `\n- ${rule.name} (${rule.id}): ${rule.instruction}`).join('');
    const precedence = rules ? `\nMatched rules; their procedure and communication instructions take precedence over the default acknowledgement and messaging policy for this ticket:${rules}` : '';
    // The origin trigger is delivered alongside the assignment, so `assignment` omits the trigger text.
    const assignment = ticket.mandate.strength === 'inferred' && ruleIds
        ? `Proactively accepted under ${ruleIds.join(', ')}. Scope: ${outcome.scope}.${precedence}${note}`
        : note.trim();
    return { name, directory: join(executionRoot(settings, stateDir), name), assignment };
}
/** Character limits for inline assignment and trigger text in worker messages; longer text is read via its resource. */
export const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600;
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
export const capped = (text: string, limit: number, read: string) => text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read };
/**
 * Formats a Trigger for worker delivery: author, thread, timestamp, text up to `TRIGGER_CHARS`, source message link,
 * optional routing note, and a preview of the replied-to message when the worker has not yet seen it.
 */
export function triggerMessage(trigger: Trigger, link: {
    source_url?: string;
    source_url_read?: string;
    source_text?: string;
}, note?: string, repliesTo?: Trigger) {
    const { source_text, ...sourceLink } = link;
    const body = source_text ?? trigger.text;
    return { trigger_id: trigger.id, from: trigger.actor.id, thread: threadKey(trigger.threads[0]!), at: trigger.at,
        ...capped(body, source_text !== undefined ? body.length : TRIGGER_CHARS, `trigger/${trigger.id}`), ...sourceLink, ...(note ? { routing_note: note } : {}),
        ...(repliesTo ? { replies_to: { trigger_id: repliesTo.id, preview: repliesTo.text.replace(/\s+/g, ' ').slice(0, 160) } } : {}) };
}
/** Formats a peer trigger from the ticket's acceptance batch with author, timestamp, 160-character preview, and read resource path. */
export const batchLine = (trigger: Trigger) => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
    preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` });
/** Returns the other triggers in a ticket's origin batch (excluding the primary `origin.triggerId`), oldest first. */
export const batchOf = (host: {
    store: Pick<Store, 'triggers'>;
}, ticket: Ticket): Trigger[] => ticket.origin.triggerIds
    .filter(id => id !== ticket.origin.triggerId).flatMap(id => host.store.triggers.get(id) ?? []);
export const RESUMED = 'This ticket ended earlier and the message that follows, on its thread, resumed it under the same mandate. If it asks for '
    + 'more within the original scope, inspect the worktree, git history and PR state and continue; if it asks for work beyond that scope or '
    + 'for another ticket, hand it back with orchestrator_trigger_handback and report dropped; if it needs nothing, such as thanks, '
    + 'report dropped without a message. Report ready when the follow-up is done. Do not repeat completed work.';
export const RETRIED = 'A person retried this ticket. Continue the assignment from the current worktree, git history and PR state.';
/** Formats a policy-change input for the worker; inputs recorded before `effect` existed fall back to a general notice. */
export function policyMessage(effect?: PolicyEffect): string {
    if (!effect)
        return 'Policy change: the access or admission rules changed. Check that the remaining work stays within the assignment.';
    return ['Policy change:',
        ...(effect.rules ?? []).map(rule => rule.change === 'disabled'
            ? `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, no longer applies: finish only a change within it, or report dropped.`
            : `Rule ${rule.name} (${rule.id}), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: ${rule.instruction}`),
        ...effect.proactive === false ? ['Work inferred from a rule is no longer accepted, as the accept mode is no longer auto: finish only '
                + 'what is in progress within the assignment, or report dropped, and take on nothing new.'] : [],
        ...effect.requesterAllowed === false ? [`The sender this ticket is for, ${effect.requester ? `${effect.requester.id} on ${effect.requester.source}` : 'who '
                + 'asked for it'}, may no longer start work here: finish the assignment within its scope, and take no new requests from them on it.`] : []].join('\n');
}
/** Resource path under which a worker session reads the full text of a ticket input. */
export const inputResource = (ticketId: string, inputId: string): string => `ticket/${ticketId}/input/${key(inputId)}`;
/**
 * Formats a ticket input for worker delivery: a `trigger` rendered via `trigger` (or by its ID and read path when absent),
 * a `policy-changed` notice, a `resumed` notice, an orchestrator `note`, or a `text` input as written.
 * Returns `undefined` for legacy `reopen` inputs, which are historical only because the schema 11 migration converted pending reopen inputs into text inputs.
 */
export function inputMessage(input: TicketInput, trigger?: object): string | undefined {
    // Mark triggers arriving on context-only subscriptions so the worker knows they are not addressed to the ticket.
    if (input.kind === 'trigger')
        return JSON.stringify({ ...trigger ?? { trigger_id: input.triggerId, read: `trigger/${input.triggerId}` },
            ...input.context ? { context: true } : {} });
    if (input.kind === 'policy-changed')
        return policyMessage(input.effect);
    if (input.kind === 'resumed')
        return RESUMED;
    if (input.kind === 'note')
        return `Note from the orchestrator, for context only: ${input.text}`;
    return input.kind === 'text' ? input.text : undefined;
}
