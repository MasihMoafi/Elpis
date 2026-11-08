// Ported from dsh-superagent (MIT), src/executor/dsh.ts
import { Later } from './effects.mts';
/**
 * Tracks active and starting worker sessions against the configured concurrency limit: a ticket holds a slot while its
 * worker's turn runs, while its shell jobs or subagents run after that turn ended, and while a launch or wake starts that worker.
 * DshExecutor reserves slots synchronously before awaiting launch or wake work so two starts cannot take the last slot,
 * and allows one extra slot beyond the limit for human follow-ups (`by === 'person'`) so they never wait behind new launches.
 */
export class WorkerSlots {
    /** Tickets currently holding a startup slot, mapped to whether the start is a launch, a wake, or a wake for a person's message. */
    private readonly starting = new Map<string, 'launch' | 'wake' | 'person'>();
    /**
     * @param running - Returns the ticket IDs whose worker holds a slot (see `DshExecutor.running`).
     * @param max - Returns the configured maximum number of concurrent worker slots.
     */
    private readonly running: () => string[];
    private readonly max: () => number;
    constructor(running: () => string[], max: () => number) { this.running = running; this.max = max; }
    /** Number of slots currently in use across running workers and starting reservations. */
    used(): number { return new Set([...this.running(), ...this.starting.keys()]).size; }
    /** How many launches may run concurrently: the slots not held by a running worker or a wake reservation. */
    launches(): number {
        const wakes = [...this.starting].flatMap(([ticketId, by]) => by !== 'launch' ? [ticketId] : []);
        return this.max() - new Set([...this.running(), ...wakes]).size;
    }
    /**
     * Reserves a startup slot for `ticketId`; idempotent if `ticketId` already holds a starting slot.
     * A wake for a person's message (`by === 'person'`) may use one extra slot beyond `max()`.
     * Call `free(ticketId)` once the worker turn is running or the launch/wake attempt ends.
     * @throws Later when no slot is free.
     */
    reserve(ticketId: string, by: 'launch' | 'wake' | 'person'): void {
        if (this.starting.has(ticketId))
            return;
        if (this.used() >= this.max() + (by === 'person' ? 1 : 0))
            throw new Later('No worker slot is free');
        this.starting.set(ticketId, by);
    }
    /** Releases `ticketId`'s starting slot once its worker session is running or the launch/wake attempt has ended. */
    free(ticketId: string): void { this.starting.delete(ticketId); }
}
