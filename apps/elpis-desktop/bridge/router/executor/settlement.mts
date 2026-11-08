// Ported from dsh-superagent (MIT), src/executor/dsh.ts
import { workerSessionId } from './messages.mts';
import type { Agent } from './runtime.mts';
import { latestReport, liveTicket, runningAssignment, waitsForPerson } from '../core/index.mts';
import type { Assignment, Ticket } from '../core/index.mts';
import { resultRelay } from '../app/notices.mts';
import { collectJob, killJobs, runningJobs, stopBackground, stopSubagents, until, untilQuiet } from './background.mts';
import type { ExecutorHost } from './dsh.mts';
const BACKGROUND_LIMIT_MS = 30 * 60000, SHUTDOWN_STOP_MS = 10000;
export class WorkerSettlement {
    private readonly host: Pick<ExecutorHost, 'context' | 'store' | 'engine' | 'sessions' | 'lifetime' | 'closing'>;
    private readonly background: (work: Promise<void>) => Promise<void>;
    private readonly retrying: (id: string) => boolean;
    private readonly resetRetry: (id: string) => void;
    constructor(host: WorkerSettlement['host'], background: WorkerSettlement['background'], retrying: WorkerSettlement['retrying'], resetRetry: WorkerSettlement['resetRetry']) { this.host = host; this.background = background; this.retrying = retrying; this.resetRetry = resetRetry; }
    isStopping(id: string) { return this.stopping.has(id); }
    isSettling(id: string) { return this.settling.has(id); }
    abort(id: string) { this.settling.get(id)?.abort(); }
    forget(id: string) { this.left.get(id)?.collect.abort(); this.left.delete(id); this.personal.delete(id); }
    person(id: string, at: string) { this.personal.set(id, at); }
    dispose() { for (const look of this.settling.values())
        look.abort(); for (const { collect } of this.left.values())
        collect.abort(); }
    /**
     * The looks at background work of workers that went idle, by ticket, which hold their slots; a look ends when its worker
     * runs again or its Assignment ends.
     */
    private readonly settling = new Map<string, AbortController>();
    /** The stops of tickets' background work that run, by ticket, which a launch or a delivery of the ticket waits for. */
    private readonly stopping = new Map<string, Promise<void>>();
    /** The jobs workers left to a person when they handed off, by ticket, and the collecting of their ends. */
    private readonly left = new Map<string, {
        jobs: Set<string>;
        collect: AbortController;
    }>();
    /** When a person's message typed into a worker's Session last started a turn, by ticket. */
    private readonly personal = new Map<string, string>();
    /** Stop what a ticket's worker runs in the background (see `stopBackground`). */
    stopWork(ticketId: string, reason: string, keepInbox = false): void {
        this.track(ticketId, stopBackground(this.host.context, workerSessionId(ticketId), reason, keepInbox));
    }
    /** A stop of a ticket's background work, which a launch or a delivery of the ticket waits for while it runs. */
    private track(ticketId: string, stop: Promise<void>): void {
        const entry: Promise<void> = Promise.all([this.stopping.get(ticketId), stop.catch(() => { })]).then(() => { })
            .finally(() => { if (this.stopping.get(ticketId) === entry)
            this.stopping.delete(ticketId); });
        this.stopping.set(ticketId, entry);
        void this.background(stop);
    }
    /** Wait for a stop of the ticket's background work that runs, unless the host stops first. */
    async stopped(ticketId: string): Promise<void> {
        const stopping = this.stopping.get(ticketId);
        if (stopping)
            await until(stopping, this.host.lifetime);
    }
    /**
     * On a host stop, for a bounded time: stop each loaded worker's background work, keeping its inbox; then end the collecting
     * of the jobs left to a person, which were killed, and cancel a worker turn that started meanwhile, keeping its inbox.
     */
    async shutdown(): Promise<void> {
        const agents = this.host.store.tickets.list().map(ticket => this.host.context.agents.get(workerSessionId(ticket.id)))
            .filter((agent): agent is Agent => agent !== undefined);
        const stop = async () => {
            await Promise.allSettled(agents.map(agent => stopBackground(this.host.context, agent.id, 'dsh-superagent stopped', true)));
            for (const { collect } of this.left.values())
                collect.abort();
            const running = agents.filter(agent => agent.status !== 'idle');
            for (const agent of running)
                agent.cancel({ kind: 'user' }, { keepInbox: true });
            await Promise.allSettled(running.map(agent => agent.whenIdle()));
        };
        await until(stop(), undefined, SHUTDOWN_STOP_MS);
    }
    /**
     * A worker that handed off to a person frees its slot: its subagents stop, and its shell jobs, such as a server for the
     * person, are left to the person until the Assignment ends. They hold no slot and run past any limit; their ends are
     * collected, so none wakes the worker outside a slot, and the worker reads of each at its next turn.
     */
    private handOff(ticketId: string, agent: Agent): void {
        this.track(ticketId, stopSubagents(this.host.context, agent, true));
        const left = this.left.get(ticketId) ?? { jobs: new Set<string>(), collect: new AbortController() };
        this.left.set(ticketId, left);
        for (const job of runningJobs(this.host.context, agent.id, left.jobs)) {
            left.jobs.add(job.id);
            void this.background(collectJob(this.host.context, agent.id, job, left.collect.signal).then(async (ended) => {
                if (!ended)
                    return;
                const note = `Your background job ${ended.name} ended: ${ended.status}.`;
                await this.host.sessions.prompt(agent.id, `ended:${job.id}`, note, { inject: 'Background job ended' });
            }));
        }
    }
    private relay({ id, text }: {
        id: string;
        text: string;
    }): void { this.host.sessions.relay(id, text); }
    async workerIdle(ticket: Ticket, idle: Assignment, agent: Agent): Promise<void> {
        await agent.whenIdle();
        // A turn that failed for a passing reason goes on after its backoff, which is no end of the turn.
        if (this.retrying(idle.id) || agent.status !== 'idle')
            return;
        // A turn that ended as turns do starts the count of passing failures again.
        this.resetRetry(idle.id);
        // The ticket while the Assignment that went idle runs it.
        const live = () => {
            const stored = this.host.store.tickets.get(ticket.id);
            return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined;
        };
        // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person;
        // an Input delivered after its result or question is new work.
        const handedOff = (stored: Ticket) => {
            const assignment = runningAssignment(stored), report = assignment?.report;
            const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at;
            return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored);
        };
        const before = live();
        if (!before || this.host.closing())
            return;
        // A turn a person started in the Session is the person's work, which goes on in the background as any turn's does.
        const report = runningAssignment(before)?.report, person = this.personal.get(ticket.id);
        // The worker read what reached it before a turn that ended: one it handed off with, or one whose background work ended.
        if (handedOff(before) && !(report && person && person > report.at)) {
            this.host.engine.turnEnded(ticket.id, idle.id);
            this.handOff(ticket.id, agent);
            return;
        }
        // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile: at most for the limit from
        // this idle, and until the worker runs again or the Assignment ends.
        this.settling.get(ticket.id)?.abort();
        const look = new AbortController(), limit = new AbortController();
        this.settling.set(ticket.id, look);
        const timer = setTimeout(() => { limit.abort(); }, BACKGROUND_LIMIT_MS);
        timer.unref?.();
        let quiet: boolean;
        const left = this.left.get(ticket.id)?.jobs;
        try {
            quiet = await untilQuiet(this.host.context, agent, AbortSignal.any([this.host.lifetime, look.signal, limit.signal]), left);
        }
        finally {
            clearTimeout(timer);
            if (this.settling.get(ticket.id) === look)
                this.settling.delete(ticket.id);
        }
        const current = live();
        if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.retrying(idle.id))
            return;
        if (quiet)
            this.host.engine.turnEnded(ticket.id, idle.id);
        let stopped = '';
        if (!quiet) {
            // Its shell jobs that ran past the limit are killed, which it is told at its next turn; its subagents, whose stop would
            // wake it, go on.
            const sessionId = workerSessionId(ticket.id), minutes = BACKGROUND_LIMIT_MS / 60000;
            const jobs = runningJobs(this.host.context, sessionId, left).map(job => job.name);
            if (jobs.length) {
                void this.background(killJobs(this.host.context, sessionId, 'The job ran past its limit', left));
                const note = `Your background jobs ran ${minutes} minutes after your turn ended and were killed: ${jobs.join(', ')}.`;
                void this.background(this.host.sessions.prompt(sessionId, `killed:${jobs.join(',')}`, note, { inject: 'Background jobs killed' }));
            }
            stopped = jobs.length ? `Background jobs ran ${minutes} minutes after the worker's turn ended and were killed: ${jobs.join(', ')}.`
                : `Subagents still ran ${minutes} minutes after the worker's turn ended.`;
        }
        // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
        if (handedOff(current))
            return;
        const last = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message').at(-1);
        const text = last?.type === 'assistant/message'
            ? last.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim() : '';
        const said = [text, stopped].filter(Boolean).join('\n\n');
        this.host.store.atomic(() => {
            const before = latestReport(current)?.summary ?? '';
            const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before });
            // A quiet final after orchestrator_report is not a new status or an empty handoff.
            if (said)
                this.relay(resultRelay(updated, 'waiting', said));
            else if (!before.trim()) {
                this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'));
            }
        });
    }
}
