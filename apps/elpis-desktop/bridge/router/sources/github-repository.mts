// Adapted from DeepSeek dsh-superagent-prototype (MIT), src/sources/github.ts.
import { stopped, cooldown, included, nameThread } from './github-poll-state.mts';
import type { Round } from './github-poll-state.mts';
import type { GithubConfig } from './github-kind.mts';
import { sameName } from '../infra/text.mts';
import { CliError, validItems } from '../infra/commands.mts';
import { ciCounts, ciFact, ciFailures, ciSummary, pullChecks } from './github-read.mts';
import { branchCiTrigger, commentTrigger, CommentSchema, issueTrigger, IssueSchema, pullTrigger, SOURCE } from './github-trigger.mts';
import { type SourceContext } from './host.mts';
import { KV } from './kv.mts';
import { cursorAt, POLL_HORIZON_MS } from './poll.mts';
import { z } from 'zod';
export const ListedSchema = CommentSchema.extend({ issue_url: z.string().nullish(), pull_request_url: z.string().nullish() });
/** Repository-wide event streams; GitHub's `/issues` endpoint includes PRs, and `/issues/comments` covers issue and PR conversation comments (excluding inline review comments). */
export const STREAMS = [
    { id: 'issues', observed: (config: GithubConfig) => config.observeIssues || config.observePulls, path: 'issues?state=all' },
    { id: 'comments', observed: (config: GithubConfig) => config.observeComments, path: 'issues/comments?' },
    { id: 'review-comments', observed: (config: GithubConfig) => config.observeComments, path: 'pulls/comments?' },
] as const;
/** Polls repository-wide streams (new Issues/PRs, comments, default-branch CI); each stream reads from when it was switched on, resets when switched off, and fails independently. */
export async function pollRepository(ctx: SourceContext, round: Round): Promise<void> {
    const config = ctx.config<GithubConfig>(SOURCE);
    if (!config)
        return;
    for (const stream of STREAMS) {
        if (stopped(ctx, round))
            return;
        if (!stream.observed(config)) {
            ctx.state.set(KV.github.stream(stream.id), undefined);
            continue;
        }
        try {
            await readStream(ctx, round, stream.id, stream.path, config);
        }
        catch (error) {
            cooldown(round, error);
            if (!stopped(ctx, round))
                round.failures.push(`${stream.id}: ${String(error)}`);
        }
    }
    // When CI observation is turned off, clear the failure baseline but preserve the revision counter so future triggers have unique IDs.
    if (!config.observeCi) {
        const seen = ctx.state.get(KV.github.branchCi);
        ctx.state.set(KV.github.branchCi, seen && { revision: seen.revision });
        return;
    }
    try {
        await pollBranchCi(ctx, round);
    }
    catch (error) {
        cooldown(round, error);
        if (!stopped(ctx, round))
            round.failures.push(`default branch CI: ${String(error)}`);
    }
}
/**
 * Polls one repository-wide event stream (oldest first) since its cursor and steps the cursor to five seconds before the
 * newest item (`cursorAt`), relying on Trigger ID deduplication so repeated messages are no-ops. While the cursor stays
 * unchanged (including when clamped to the hourly horizon), sending the last page's ETag makes an unchanged list return
 * HTTP 304 and cost no rate limit. Items from before their kind was switched on or beyond the horizon are ignored.
 */
export async function readStream(ctx: SourceContext, round: Round, id: string, path: string, config: GithubConfig): Promise<void> {
    const name = KV.github.stream(id);
    const stored = ctx.state.get(name);
    const kinds = id === 'issues' ? [...config.observeIssues ? ['issues'] : [], ...config.observePulls ? ['pulls'] : []] : ['comments'];
    const before = typeof stored?.started === 'object' ? stored.started : {};
    const started: Record<string, string> = Object.fromEntries(kinds.map(kind => [kind, before[kind] ?? round.started]));
    const horizon = Math.floor((Date.parse(round.started) - POLL_HORIZON_MS) / 3600000) * 3600000;
    const since = new Date(Math.max(Date.parse(stored?.since ?? round.started), horizon)).toISOString();
    const conditional = stored?.etag && stored.since === since ? ['-H', `If-None-Match: ${stored.etag}`] : [];
    let raw: string;
    const listed = `${path}&sort=updated&direction=asc&per_page=100&since=${encodeURIComponent(since)}`;
    try {
        raw = await ctx.commands.withSignal(round.signal).api(listed, '--include', ...conditional);
    }
    catch (error) {
        if (error instanceof CliError && error.code === 304)
            return;
        throw error;
    }
    const { headers, body } = included(raw);
    const paged = /rel="next"/.test(headers);
    const items = paged ? await ctx.commands.withSignal(round.signal).pages(ListedSchema, listed, round.tally)
        : validItems(ListedSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally);
    const { login } = ctx.deployment.github;
    const fresh = (at: string | null | undefined, kind: string) => kind in started && Date.parse(at ?? '') >= Math.max(Date.parse(started[kind]!), horizon);
    for (const item of items) {
        // Stopping mid-stream aborts before advancing the cursor so unread items are retried.
        if (stopped(ctx, round))
            throw new Error('The GitHub Source stopped during the poll');
        if (sameName(item.user.login, login))
            continue;
        if (id === 'issues') {
            const issue = IssueSchema.safeParse(item);
            const pr = issue.success && !!issue.data.pull_request;
            if (!issue.success || !fresh(issue.data.created_at, pr ? 'pulls' : 'issues'))
                continue;
            await ctx.receive(pr ? pullTrigger(issue.data, login) : issueTrigger(issue.data, login));
            nameThread(ctx, issue.data.number, issue.data.title);
            continue;
        }
        const number = Number(/\/(?:issues|pulls)\/(\d+)$/.exec((id === 'comments' ? item.issue_url : item.pull_request_url) ?? '')?.[1]);
        if (!number || !fresh(item.updated_at ?? item.created_at, 'comments'))
            continue;
        const isPr = id === 'review-comments' || /\/pull\//.test(item.html_url ?? '');
        const ref = { number, isPr, ...item.html_url ? { url: item.html_url } : {} };
        const trigger = commentTrigger(item, ref, id === 'comments' ? 'conversation' : 'inline', login);
        if (trigger.text)
            await ctx.receive(trigger);
    }
    const newest = Math.max(...items.map(item => Date.parse(item.updated_at ?? '')).filter(Number.isFinite));
    const moved = Number.isFinite(newest) ? cursorAt(new Date(newest).toISOString()) : since;
    const next = Date.parse(moved) > Date.parse(since) ? moved : since;
    const etag = /^etag:\s*(.+)$/im.exec(headers)?.[1]?.trim();
    // The ETag belongs to this request, which the next round repeats only while the cursor stays unchanged.
    ctx.state.set(name, { since: next, started, ...!paged && etag && next === since ? { etag } : {} });
}
/** Polls default-branch CI checks, emitting a trigger only when the set of failing checks changes after the initial baseline. */
export async function pollBranchCi(ctx: SourceContext, round: Round): Promise<void> {
    const commands = ctx.commands.withSignal(round.signal);
    const { default_branch: branch } = await commands.api(z.looseObject({ default_branch: z.string() }), '');
    const head = await commands.api(z.looseObject({ sha: z.string() }), `commits/${encodeURIComponent(branch)}`);
    const snapshot = await pullChecks(commands, head.sha, round.tally);
    const previous = ctx.state.get(KV.github.branchCi);
    // The first observation after switching on or renaming the default branch establishes the baseline.
    const known = previous?.branch === branch ? previous.failures : undefined;
    const failures = ciFailures(snapshot);
    const counts = ciCounts(snapshot);
    // Retain previous failures while checks are still running so recovery is reported only once all checks pass.
    const now = failures.length || !counts.running ? failures : known ?? [];
    let revision = previous?.revision ?? 0;
    if (known && JSON.stringify(now) !== JSON.stringify(known)) {
        revision += 1;
        const summary = ciSummary(snapshot, branch, `github/commits/${head.sha}/checks`);
        const url = `https://github.com/${ctx.deployment.repository}/commit/${head.sha}`;
        await ctx.receive(branchCiTrigger(branch, head.sha, revision, summary, url));
        ctx.threads.describe(`github:ci:${branch}`, { label: `CI on ${branch}`, facts: { ci: ciFact(counts) } });
    }
    ctx.state.set(KV.github.branchCi, { branch, failures: now, revision });
}
