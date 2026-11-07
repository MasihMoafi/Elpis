import type { NoticeParams,LiveSession,ContextChars,UsageTotals } from "./bridge-types.mts";
import { splitContext,splitTokens,transcriptReader } from "./context-split.mts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BridgeEnvironment } from "./bridge-server.mts";

type Dependencies = Pick<BridgeEnvironment, "claudeAccounts"> & {
  sessions: Map<string, LiveSession>;
  threadCwd: Map<string, string>;
  notify: (method: string, params: NoticeParams) => void;
};

/** Track per-chat token usage and attribute context to transcript parts. */
export function createUsageTracker({ sessions, threadCwd, claudeAccounts, notify }: Dependencies) {
  const tokenSums = new Map<string, UsageTotals>();
  const ctxChars = new Map<string, ContextChars>();
  const devChars = new Map<string, number>();
  const addChars = (threadId: string, part: keyof ContextChars, n: number) => { const c = ctxChars.get(threadId) ?? { user: 0, agent: 0, reasoning: 0, toolCalls: 0, toolResults: 0 }; c[part] += n ?? 0; ctxChars.set(threadId, c); };
  // A Claude chat's parts come from Claude's own token counts in its Claude Code transcript, so
  // they hold after Elpis restarts and count the thinking Claude keeps in context. Other chats,
  // and a transcript not found, count text length as their turns stream.
  const readTranscript = transcriptReader(); // the Context Ledger's split; cheap on a long transcript
  const transcriptOf = (threadId: string) => {
    const live = sessions.get(threadId);
    if (live?.agent !== "claude") return null;
    const project = (threadCwd.get(threadId) ?? process.cwd()).replace(/[^a-zA-Z0-9]/g, "-");
    return join(claudeAccounts.configDir(live.accountId ?? "default"), "projects", project, `${live.id}.jsonl`);
  };
  const attribution = (threadId: string, used: number) => {
    const file = transcriptOf(threadId);
    if (file && existsSync(file)) {
      const t = readTranscript(file);
      return splitTokens({ developerMessages: Math.round((devChars.get(threadId) ?? 0) / 4), userMessages: t.user, agentMessages: t.agent, reasoning: t.reasoning, toolCalls: t.toolCalls, toolResults: t.toolResults }, used);
    }
    return splitContext(ctxChars.get(threadId), devChars.get(threadId), used);
  };
  const lastContext = new Map<string, { used?: number; size?: number | null }>();
  const lastTurnUsage = new Map<string, UsageTotals>(); // thread id -> its latest finished turn's usage
  // Anthropic reports cache reads and writes apart from input; Elpis (like OpenAI) counts them as input.
  const usageBreakdown = (u: Partial<UsageTotals>) => {
    const input = (u.input ?? 0) + (u.cachedRead ?? 0) + (u.cachedWrite ?? 0);
    return { totalTokens: input + (u.output ?? 0), inputTokens: input, cachedInputTokens: u.cachedRead ?? 0, cacheWriteInputTokens: u.cachedWrite ?? 0, outputTokens: u.output ?? 0, reasoningOutputTokens: 0 };
  };
  const sendUsage = (threadId: string, turnId: string, last: UsageTotals | null) => {
    const sum = tokenSums.get(threadId) ?? {};
    const ctx = lastContext.get(threadId) ?? {};
    // Elpis reads `last` as the latest request, whose total is the context now. Claude reports
    // a whole turn (or nothing yet): its output stays, the rest of the context is input.
    const lastB = usageBreakdown(last ?? lastTurnUsage.get(threadId) ?? {});
    if (typeof ctx.used === "number") {
      const output = Math.min(lastB.outputTokens, ctx.used);
      const input = ctx.used - output;
      const cached = Math.min(lastB.cachedInputTokens, input);
      Object.assign(lastB, { totalTokens: ctx.used, inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteInputTokens: Math.min(lastB.cacheWriteInputTokens, input - cached) });
    }
    if (last) lastTurnUsage.set(threadId, last);
    const contextAttribution = typeof ctx.used === "number" ? attribution(threadId, ctx.used) : undefined;
    notify("thread/tokenUsage/updated", { threadId, turnId, tokenUsage: { total: usageBreakdown(sum), last: lastB, modelContextWindow: ctx.size ?? null, ...(contextAttribution && { contextAttribution }) } });
  };
  return { tokenSums, ctxChars, devChars, addChars, transcriptOf, lastContext, lastTurnUsage, sendUsage };
}
