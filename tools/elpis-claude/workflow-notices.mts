import type { NoticeRun } from './workflow-types.mts';
import path from "node:path";
export const NOTICE_RESULT_CHARS = 60000;
// The person's own request: Claude Code honours "ultracode" or their words asking for a workflow, on turns a person
// started. Autonomous turns (a workflow's notice, a background job's reply) never count.
export const NOTICE_TAG = "<workflow-notification>";
export const ASKED = /\bultracode\b|\b(?:use|run|start|launch|create|write|try|with|via|through|using)\s+(?:a|an|the|this|that|my|one|some|\w+\s+)?\s*(?:multi-agent\s+)?workflows?\b|\bworkflows?\s+(?:tool|run)\b|\bfan(?:ning)?\s+out\b[^.\n]{0,40}\bagents?\b/i;
export function personAskedForWorkflow(texts: unknown[]) {
    return texts.some((t) => typeof t === "string" && !t.trimStart().startsWith(NOTICE_TAG) && ASKED.test(t));
}
export function noticeText(run: NoticeRun) {
    let result = run.status === "completed" ? JSON.stringify(run.result ?? null, null, 2) : null;
    const cut = result && result.length > NOTICE_RESULT_CHARS;
    if (cut)
        result = `${(result as string).slice(0, NOTICE_RESULT_CHARS)}\n… (cut; the full result is in ${path.join(run.dir, "result.json")})`;
    const agents = run.agents.length, failed = run.agents.filter((a) => a.state === "failed").length;
    const secs = Math.round(((run.endedAt ?? run.updatedAt) - run.createdAt) / 1000);
    const summary = run.status === "completed" ? `Workflow "${run.name}" completed: ${agents} agents${failed ? ` (${failed} returned null after retries)` : ""}, ${secs} s.`
        : run.status === "stopped" ? `Workflow "${run.name}" was stopped by the person after ${agents} agents.`
            : `Workflow "${run.name}" failed: ${run.error}`;
    return [NOTICE_TAG, `<run-id>${run.id}</run-id>`, `<name>${run.name}</name>`, `<status>${run.status}</status>`, `<summary>${summary}</summary>`,
        ...(result !== null ? [`<result>\n${result}\n</result>`] : []), ...(run.status === "stopped" ? ["Do not restart it unless the person asks."] : []), `<script-path>${run.scriptPath}</script-path>`,
        `<journal>${path.join(run.dir, "journal.jsonl")}</journal>`, "</workflow-notification>"].join("\n");
}
