import type { Dependencies } from './bridge-turn-types.mts';
import { statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { clipTurn } from "./bridge-transcript.mts";
import type { ProviderAgent, ProviderTurn, TranscriptItem, TranscriptTurn, UsageTotals } from "./bridge-types.mts";
export async function completeProviderTurn({ now, updateStore, sessions, activeTurns, notify, announceLimits, recordAccounts, log, runNext, lastTurnUsage }: Pick<Dependencies, 'now' | 'updateStore' | 'sessions' | 'activeTurns' | 'notify' | 'announceLimits' | 'recordAccounts' | 'log' | 'runNext' | 'lastTurnUsage'>, { threadId, turnId, lead, items, status, error, startedAt, t0, lastClaudeMessageId, turnState, agent, firstTokenAt, finishTurn }: {
    threadId: string;
    turnId: string;
    lead: TranscriptItem[];
    items: TranscriptItem[];
    status: string;
    error: TranscriptTurn['error'];
    startedAt: number;
    t0: number;
    lastClaudeMessageId: string | null;
    turnState: ProviderTurn;
    agent: ProviderAgent;
    firstTokenAt: number | null;
    finishTurn(): void;
}) {
    const completedAt = Math.floor(now() / 1000);
    {
        const record = clipTurn({ id: turnId, items: [...lead, ...items], itemsView: "full", status, error, startedAt, startedAtMs: t0, completedAt, durationMs: (completedAt - startedAt) * 1000, ...((lastClaudeMessageId as string | null) && { claudeMessageId: lastClaudeMessageId as string | null }) });
        await updateStore((st) => {
            const { active: _active, ...rest } = st[threadId] ?? {}, sessionId = sessions.get(threadId)?.id;
            const loaded = new Map((rest.contextSessionId === sessionId ? rest.contextFiles ?? [] : []).map(file => [file.path, file]));
            for (const item of record.items)
                if (item.status === 'completed')
                    for (const action of item.commandActions ?? []) {
                        if (action.type === 'read' && typeof action.path === 'string' && action.path.endsWith('/SKILL.md')) {
                            let bytes = 0;
                            try {
                                bytes = statSync(action.path).size;
                            }
                            catch { }
                            loaded.set(action.path, { name: basename(dirname(action.path)), path: action.path, group: 'skills', estimatedTokens: Math.ceil(bytes / 4), included: true, selectable: false, reason: `Read by ${agent.speaker} in this session` });
                        }
                    }
            st[threadId] = { ...rest, turns: [...(rest.turns ?? []), record], contextSessionId: sessionId, contextFiles: [...loaded.values()] };
        });
    }
    if (activeTurns.get(threadId) === turnState)
        activeTurns.delete(threadId);
    notify("turn/completed", { threadId, turn: { id: turnId, items, itemsView: "summary", status, error, startedAt, completedAt, durationMs: (completedAt - startedAt) * 1000 } });
    notify("turn/activityUpdated", { threadId, turnId, status: status === "inProgress" ? "completed" : status, durationMs: now() - t0, timeToFirstTokenMs: firstTokenAt ? firstTokenAt - t0 : null });
    notify("thread/status/changed", { threadId, status: { type: "idle" } });
    announceLimits(agent, notify);
    if (agent.key === "agy")
        recordAccounts().catch((e) => log(`accounts: ${e.message}`));
    setImmediate(() => runNext(threadId));
    const used: Partial<UsageTotals> = lastTurnUsage.get(threadId) ?? {};
    finishTurn();
    return { status, turnId, seconds: completedAt - startedAt, tokens: (used.input ?? 0) + (used.cachedRead ?? 0) + (used.cachedWrite ?? 0) + (used.output ?? 0) };
}
