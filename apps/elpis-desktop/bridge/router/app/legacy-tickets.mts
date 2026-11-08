// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/app/migration.ts.
import { isObject, text } from './legacy-values.mts';
import type { Stored } from './legacy-values.mts';
import { basename } from 'node:path';
import { said, type AcceptMode, type AdmissionCell, type ChannelRef, type Execution, type Follow, type MandateBasis, type Reason, type Ticket, type TicketInput } from '../core/index.mts';
export const CELLS: readonly string[] = ['listedUnaddressed', 'unlistedAddressed', 'unlistedUnaddressed'];
/**
 * Upgrade a legacy mandate basis object to the current tagged union shape.
 * Current bases recorded `source` and `scope`; older ones recorded a Feishu chat directly (`chatId`) or schema 6's `legacyAuthority`.
 * A basis with neither an admission table cell nor `followup` came from a listed sender (`addressed` when it recorded `addressed`, `sender`, and `source`, else `listed`), which holds while the sender remains listed.
 */
export function basisOf(stored: unknown): MandateBasis {
    // Missing or non-object bases default to a listed-sender basis (`via: 'listed'`).
    const old = isObject(stored) ? stored : {};
    if (typeof old.via === 'string')
        return old as Stored & MandateBasis;
    // Older Feishu bases recorded `chatId` and `direct` at the top level instead of inside `scope`.
    const chat = text(old.chatId) ? { source: 'feishu', scope: { chatId: old.chatId, direct: old.direct === true } } : {};
    const received = text(old.source) ? { source: old.source as string, ...isObject(old.scope) ? { scope: old.scope } : {}, ...text(old.row) ? { row: old.row as string } : {} } : chat;
    const sender = text(old.sender) ?? text(old.member);
    const common = { ...received, ...sender ? { sender } : {}, ...Array.isArray(old.rules) ? { rules: old.rules as string[] } : {} };
    const addressed = old.addressed === 'mention' || old.addressed === 'direct' ? old.addressed
        : old.direct === true ? 'direct' as const : old.mention === true ? 'mention' as const : undefined;
    const mode = text(old.mode) as AcceptMode | undefined;
    // Schema 6 imports recorded `legacyAuthority`.
    const authority = text(old.legacyAuthority) ? { authority: old.legacyAuthority as string } : {};
    if (old.followup === true)
        return { via: 'followup', ...common, ...authority };
    if (CELLS.includes(String(old.admission))) {
        return { via: 'admission', ...common, cell: old.admission as AdmissionCell, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: { mode: mode ?? 'auto' } } : {} };
    }
    if (addressed && sender && text(old.source))
        return { via: 'addressed', ...common, addressed };
    // Any basis with neither a table cell nor `followup` came from a listed sender.
    return { via: 'listed', ...common, ...addressed ? { addressed } : {}, ...old.observation === true ? { observation: mode ? { mode } : {} } : {}, ...authority };
}
/**
 * Upgrade a schema 10 ticket record to schema 11: extracts `origin`, `execution`, `delivery`, and followed PR threads
 * (`follows`) from `meta` and GitHub opener channels, merges reported `answers`, marks human trigger inputs (`human: true`),
 * and converts pending `reopen` inputs into `text` inputs for the worker.
 */
export function ticketOf(old: Stored, answers = new Map<string, string[]>(), human: (triggerId: string) => boolean = () => false, closed: (number: number) => Follow['closed'] = () => undefined): Ticket {
    const { meta: storedMeta, ...rest } = old as Stored & Ticket & {
        meta?: Stored;
    };
    const ticket = rest;
    const meta = storedMeta ?? {};
    const triggerId = text(meta.sourceTriggerId) ?? '';
    const triggerIds = Array.isArray(meta.triggerIds) ? meta.triggerIds as string[] : triggerId ? [triggerId] : [];
    const directory = text(meta.workspace);
    // Remaining `meta` fields are obsolete: schema 6 task states stay in the `task` table, and accept fields live on `execution` and `mandate`.
    const execution: Execution | undefined = directory ? { name: text(meta.name) ?? basename(directory), directory,
        assignment: text(meta.assignment) ?? text(meta.legacyPrompt) ?? '' } : undefined;
    const inputs = ticket.inputs.map((input): TicketInput => input.kind === 'trigger' ? { ...input, ...human(input.triggerId) ? { human: true } : {} }
        : input.kind !== 'reopen' || !ticket.undelivered.includes(input.id) ? input
            : { id: input.id, kind: 'text', at: input.at, text: JSON.stringify({ resumed: true, decision_id: input.decisionId, read: `ticket/${ticket.id}/assignment`,
                    note: 'This ticket ended earlier and a follow-up resumed it under the same mandate. Inspect the worktree, git history and PR state before continuing; do not repeat completed external operations.' }) });
    const reported = [...new Set([...ticket.answers ?? [], ...answers.get(ticket.id) ?? []])];
    const ended = ticket.ended && { ...ticket.ended, outcome: ticket.ended.outcome ?? outcomeOf(ticket.ended) };
    const mandate = { ...ticket.mandate, basis: basisOf(ticket.mandate.basis as unknown) };
    const delivery = ticket.delivery ?? (text(meta.deliveryError) ? { error: meta.deliveryError as string, at: ticket.updatedAt } : undefined);
    const kept = execution ?? ticket.execution;
    const follows = ticket.follows ?? followsOf(meta, ticket.channels, closed);
    return { ...ticket, inputs, ...ended ? { ended } : {}, mandate, origin: ticket.origin ?? { triggerId, triggerIds },
        // A ticket stopped by a person receives no further work, so clear any undelivered inputs.
        ...ended?.by === 'human' ? { undelivered: [] } : {},
        ...kept ? { execution: kept } : {}, ...delivery ? { delivery } : {},
        channels: ticket.channels.filter(channel => !opener(channel)), ...follows.length ? { follows } : {},
        ...reported.length ? { answers: reported } : {} };
}
/** Schema 10 recorded a PR opened by the ticket as a GitHub Channel without a comment URL (`address.url`). */
export const opener = (channel: ChannelRef): boolean => channel.source === 'github' && !channel.address.url && !!Number(channel.address.number);
/**
 * Reconstruct followed PR threads from legacy ticket metadata (`meta.prNumber` last, after PRs opened via GitHub opener
 * channels), marking opened PRs `own: true` and attaching recorded close outcomes.
 */
export function followsOf(meta: Stored, channels: ChannelRef[], closed: (number: number) => Follow['closed']): Follow[] {
    const opened = channels.filter(opener).map(channel => Number(channel.address.number));
    const bound = typeof meta.prNumber === 'number' ? [meta.prNumber] : [];
    return [...new Set([...opened.filter(number => !bound.includes(number)), ...bound])].map(number => {
        const end = closed(number);
        return { thread: `github:${number}`, own: opened.includes(number), ...end ? { closed: end } : {} };
    });
}
/** Parse a schema 10 `github-ended:<number>` record into a followed PR's `closed` state when valid. */
export function pullEnd(stored: unknown): Follow['closed'] {
    if (!isObject(stored) || typeof stored.at !== 'string' || (stored.reason !== 'merged' && stored.reason !== 'closed'))
        return undefined;
    return { at: stored.at, outcome: stored.reason };
}
/**
 * Strip redundant fields stored twice on legacy tickets: removes `state` (derived from `ended`), moves top-level `summary`
 * onto the latest Assignment as a `progress` report when no Assignment has a report, and removes `execution.session` and
 * per-Assignment `ticketId` and `ref` (derived from `ticket.id`).
 */
export function withoutCopies(old: Stored): Ticket {
    const { state, summary, ...ticket } = old as Stored & Ticket & {
        state?: string;
        summary?: unknown;
    };
    const assignments = ticket.assignments.map(item => {
        const { ticketId: _ticket, ref: _ref, ...rest } = item as typeof item & {
            ticketId?: string;
            ref?: string;
        };
        return rest;
    });
    const latest = assignments.at(-1);
    if (latest && typeof summary === 'string' && summary && !assignments.some(item => item.report)) {
        latest.report = { state: 'progress', summary, at: ticket.updatedAt };
    }
    const { session: _session, ...execution } = (ticket.execution ?? {}) as Partial<Execution> & {
        session?: string;
    };
    // An open ticket has no `ended` record; a ticket marked `ended` without one defaults to `closed`.
    const closed = { at: ticket.updatedAt, by: 'executor' as const, reason: 'closed', outcome: 'closed' as const };
    const ended = state === 'open' ? undefined : ticket.ended ?? (state === 'ended' ? closed : undefined);
    const { ended: _ended, ...rest } = ticket;
    // Retain `ended.reason` only when it differs from `ended.outcome`, and drop duplicate end reasons from assignments stopped by that end.
    const { reason, ...end } = ended ?? {} as NonNullable<Ticket['ended']>;
    const once = ended && { ...end, ...reason && reason !== ended.outcome ? { reason } : {} } as NonNullable<Ticket['ended']>;
    for (const item of assignments)
        if (ended && item.endedReason === reason && item.endedAt === ended.at)
            delete item.endedReason;
    return { ...rest, ...once ? { ended: once } : {}, assignments, ...ticket.execution ? { execution: execution as Execution } : {} };
}
/** Fixed English reason sentences written by versions before schema 11, mapped to their current reason codes. */
export const SENTENCES: Readonly<Record<string, string>> = {
    'Assessment timed out': 'timeout', 'Assessment interrupted or timed out': 'timeout',
    'Assessment interrupted, timed out or ended without a decision': 'timeout',
    'Policy changed during assessment': 'policyChanged', 'Access or rule version changed': 'policyChanged',
    'No admissible trigger': 'noAdmissible', 'Explicit member request routed by the orchestrator': 'explicitRouted',
    'Explicit request from an allowed sender routed by the orchestrator': 'explicitRouted',
    'Imported from the pre-domain-model task record': 'legacyImport', 'host restarted': 'hostRestarted', 'Human asked to stop': 'humanStop',
    'Forwarded to the existing topic worker': 'forwarded', 'Sender is not an authorized human member': 'senderNotMember',
    'Retried by a person': 'retried', 'Stop target is unknown or already ended': 'stopUnknown',
    'Stop requires an explicit instruction from an authorized member': 'stopNotExplicit',
    'Implementation intent or target direction is not established, or a product/design decision is still required': 'directionUnsettled',
    'No enabled admission rule matched': 'noRuleMatched',
};
/** Parse a legacy reason string into a `Reason` when it matches a fixed sentence in `SENTENCES`, a parameterized sentence (`routed`, `startedTicket`, `observed`), or a snake_case gate/source code. */
export function knownReason(text: string): Reason | undefined {
    if (SENTENCES[text])
        return { code: SENTENCES[text] };
    const routed = /^Routed to ticket (\S+)$/.exec(text) ?? /^Already accepted as ticket (\S+)$/.exec(text);
    if (routed)
        return { code: text.startsWith('Routed') ? 'routed' : 'startedTicket', values: { ticket: routed[1]! } };
    const observed = /^Observe mode: would accept \((.*)\)$/s.exec(text);
    if (observed)
        return { code: 'observed', values: { text: observed[1]! } };
    return /^[a-z]+(?:_[a-z]+)+$/.test(text) ? { code: text } : undefined;
}
/**
 * Parse a stored Decision reason into structured `Reason` codes: splits `<triggerId>: <reason>` batches joined by `; `
 * into per-Trigger reasons, maps known sentences/codes via `knownReason`, and wraps any other free-form assessor or human
 * text with `said`.
 */
export function reasonsOf(stored: unknown): Reason[] {
    if (Array.isArray(stored))
        return stored as Reason[];
    const text = typeof stored === 'string' ? stored : '';
    const parts = text.split('; ').map(part => /^([^:\s]+): (.+)$/s.exec(part));
    if (parts.every(match => match && knownReason(match[2]!)))
        return parts.map(match => ({ ...knownReason(match![2]!)!, triggerId: match![1]! }));
    return [knownReason(text) ?? said(text)];
}
/** Infer a ticket's `ended.outcome` when predating recorded outcomes (`stopped` for human stops, else matching `reason` or defaulting to `closed`). */
export function outcomeOf(ended: Pick<NonNullable<Ticket['ended']>, 'by' | 'reason'>): NonNullable<Ticket['ended']>['outcome'] {
    if (ended.by === 'human')
        return 'stopped';
    return (['completed', 'merged', 'closed', 'dropped'] as const).find(outcome => outcome === ended.reason) ?? 'closed';
}
