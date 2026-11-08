import { pollRepository } from './github-repository.mts';
import { newRound, stopped, RETRY_WINDOW_MS, retryDelay, deleted, failed, nameThread } from './github-poll-state.mts';
import type { Round, Retry } from './github-poll-state.mts';
export type { Retry } from './github-poll-state.mts'
import { githubKind } from './github-kind.mts';
import type { GithubConfig } from './github-kind.mts';
export { githubKind } from './github-kind.mts'
export type { GithubConfig } from './github-kind.mts'
// Ported from dsh-superagent (MIT), src/sources/github.ts
/** GitHub source kind definition, notification and repository polling loops, and Cordis plugin entry. */

import { key, type Thread } from '../core/index.mts';
import { sameName } from '../infra/text.mts';

import { CliError, validItems } from '../infra/commands.mts';
import { ciCounts, ciFact, ciSummary, pullChecks } from './github-read.mts';
import { ciTrigger, commentTrigger, CommentSchema, githubAddress, issueTrigger, IssueSchema, pullTrigger, SOURCE } from './github-trigger.mts';

import type { PullRef } from './github-trigger.mts';
import { observePull, pullsOf, readPull, type Pull } from './github-pull.mts';
import { health, sourceContext, type Health, type SourceContext } from './host.mts';
import { KV } from './kv.mts';
import { cursorAt, pause, pollThreads as pollEach } from './poll.mts';

import { z } from 'zod';

export { commentTrigger, type GithubComment } from './github-trigger.mts'
/** A notification of the agent account; `subject.url` is the API address of its Issue or PR. */
const NotificationSchema = z.looseObject({
  repository: z.looseObject({ full_name: z.string() }), subject: z.looseObject({ url: z.string().nullish() }),
})
/** Start the source and release its resources on disposal. */
export function startGithub(host: import('./host.mts').SourceHost): () => Promise<void> {
  const release = host.sources.register(githubKind)
  const source = sourceContext(host, githubKind)
  const controller = new AbortController()
  const running = watchGithub(source, controller.signal)
    .catch((error: unknown) => { source.report('github', { state: 'error', detail: String(error) }) })
  return async () => { controller.abort(); await running; release() }
}
/** Returns an error health once `failures` consecutive polls fail, or undefined so a single network interruption stays quiet. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}
export async function watchGithub(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  // Setup restarts dsh-superagent once it resolves the accounts; until then nothing is polled.
  while (!signal.aborted) {
    if (!ctx.configured()) { ctx.report('github', health('paused', 'setupPending')); await pause(2000, signal); continue }
    const config = ctx.config<GithubConfig>(SOURCE)
    let retryAt = 0
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('github', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      retryAt = error instanceof CliError ? error.retryAt ?? 0 : 0
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('github', failed)
    }
    const cadence = Math.max(interval, ctx.config<GithubConfig>(SOURCE)?.pollSeconds ?? 60) * 1000
    await pause(Math.max(retryDelay(cadence, failures), retryAt - Date.now()), signal)
  }
}
/**
 * One polling round: notifications, then observed repository streams, then the PRs of open tickets with their CI, then
 * subscribed Threads. Each step and each Issue, PR, or Thread fails independently so all steps run before the round fails.
 * Other read failures (including 404) fail the round toward the error threshold, whereas deleted (410) or abandoned
 * (24h+) threads are recorded only on the thread and in health detail.
 * @returns the polling interval requested by GitHub, in seconds.
 */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  const notified = await pollNotifications(ctx, round).then(value => ({ value }), (error: unknown) => ({ error }))
  await pollRepository(ctx, round)
  await pollTicketPulls(ctx, signal, round)
  await pollThreads(ctx, signal, round)
  if ('error' in notified) throw notified.error
  const { count, interval } = notified.value
  if (signal?.aborted) return interval
  if (round.failures.length) throw new CliError(`${round.failures.length} GitHub reads failed: ${round.failures.slice(0, 3).join('; ')}`, undefined, undefined, round.retryAt || undefined)
  const named = (numbers: number[]) => [...new Set(numbers)].sort((a, b) => a - b).map(number => `#${number}`).join(', ')
  const dropped = (round.dropped.length ? `; deleted on GitHub: ${named(round.dropped)}` : '')
    + (round.abandoned.length ? `; dropped after their reads kept failing: ${named(round.abandoned)}` : '')
    + (round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : '')
  ctx.report('github', { state: 'ready', detail: `${count} notifications; next poll ≥ ${interval}s${dropped}`, at: round.started })
  return interval
}
/** Reads notifications since the cursor and each Issue or PR they name, advancing the cursor atomically with the retry map for failed reads; deleted (410) Issues are dropped once their error is recorded. */
async function pollNotifications(ctx: SourceContext, round: Round): Promise<{ count: number; interval: number }> {
  const { state } = ctx
  const commands = ctx.commands.withSignal(round.signal)
  const since = state.get(KV.github.since) ?? round.started
  if (state.get(KV.github.since) === undefined) state.set(KV.github.since, since)
  const { repository } = ctx.deployment
  const path = `notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`
  const raw = await commands.api(path, '--include')
  const split = raw.search(/\r?\n\r?\n/)
  if (split < 0) throw new Error('GitHub returned no HTTP headers')
  const headers = raw.slice(0, split)
  const body = raw.slice(split).trim()
  const asked = Number(/x-poll-interval:\s*(\d+)/i.exec(headers)?.[1] ?? 60)
  const interval = Math.max(60, Number.isFinite(asked) ? asked : 60)
  const notifications = /rel="next"/.test(headers)
    ? await commands.pages(NotificationSchema, path, round.tally)
    : validItems(NotificationSchema, z.array(z.unknown()).parse(JSON.parse(body)), round.tally)
  const retries = { ...state.get(KV.github.retries) }
  // Failed items from the previous round run first, followed by newly notified items in chronological order; each is read once.
  const items = new Map(Object.entries(retries).map(([number, retry]) => [Number(number), retry]))
  for (const notification of notifications.reverse()) {
    if (!sameName(notification.repository.full_name, repository)) continue
    const address = githubAddress(notification.subject.url ?? '', repository)
    if (!address || address.discussion || items.has(address.number)) continue
    const { number, pr } = address
    items.set(number, { since: [state.get(KV.github.cursor(number)) ?? since, since].sort().at(-1)!, pr })
  }
  for (const [number, item] of items) {
    if (stopped(ctx, round)) return { count: notifications.length, interval }
    round.read.add(number)
    const expired = item.failedAt && Date.parse(round.started) - Date.parse(item.failedAt) >= RETRY_WINDOW_MS
    if (!expired && (item.nextAt ?? 0) > Date.parse(round.started)) continue
    try {
      await readNotified(ctx, round, number, item)
      delete retries[number]
    } catch (error) {
      if (stopped(ctx, round)) return { count: notifications.length, interval }
      const retry = { ...item, failedAt: item.failedAt ?? round.started, attempts: (item.attempts ?? 0) + 1 }
      const cadence = Math.max(interval, ctx.config<GithubConfig>(SOURCE)?.pollSeconds ?? 60) * 1000
      retry.nextAt = Math.max(Date.parse(round.started) + retryDelay(cadence, retry.attempts), error instanceof CliError ? error.retryAt ?? 0 : 0)
      // Abandon notification retries after 24 hours of failures so a permanently unreadable thread does not hold source health in error; its cursor stays so a later notification or thread poll still reads what was missed.
      const abandoned = Date.parse(round.started) - Date.parse(retry.failedAt) >= RETRY_WINDOW_MS
      failed(ctx, round, number, error, abandoned)
      if (!deleted(error) && !abandoned) { retries[number] = retry; continue }
      delete retries[number]
    }
  }
  ctx.atomic(() => { state.set(KV.github.since, cursorAt(round.started)); state.set(KV.github.retries, retries) })
  return { count: notifications.length, interval }
}
async function readNotified(ctx: SourceContext, round: Round, number: number, item: Retry): Promise<void> {
  const { since } = item
  let isPr = item.pr
  if (!isPr) {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    // `issues/<n>` also returns PRs with `pull_request` set; handle them in the PR branch below.
    isPr = !!issue.pull_request
    if (!isPr) {
      // An Issue opened by someone other than the agent since the cursor brings its body so a mention in it reaches the gate.
      // A mention added by a later edit to the body is not read: only the author can be the actor of the body.
      const { login } = ctx.deployment.github
      const opened = Date.parse(issue.created_at) >= Date.parse(since) && !sameName(issue.user.login, login)
      if (opened) await ctx.receive(issueTrigger(issue, login))
      await intakeComments(ctx, { number, isPr: false, url: issue.html_url }, since, round)
      nameThread(ctx, number, issue.title)
    }
  }
  if (isPr) {
    const pr = await pull(ctx, round, number)
    // Emit a PR description trigger for PRs opened since the cursor; its ID is the same as the one produced by the repository PR stream.
    const { login } = ctx.deployment.github
    if (pr.created_at && Date.parse(pr.created_at) >= Date.parse(since) && !sameName(pr.user.login, login)) {
      const opened = { number, title: pr.title ?? '', body: pr.body, user: pr.user, created_at: pr.created_at, html_url: pr.html_url }
      await ctx.receive(pullTrigger(opened, login))
    }
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
    if (pr.title) nameThread(ctx, number, pr.title)
  }
  ctx.state.set(KV.github.cursor(number), cursorAt(round.started))
  ctx.threads.patch(`github:${number}`, { pollError: undefined })
}
/** Reads and observes a PR at most once per polling round. */
function pull(ctx: SourceContext, round: Round, number: number): Promise<Pull> {
  let read = round.pulls.get(number)
  if (!read) {
    read = readPull(ctx, number, round.signal).then(pr => { observePull(ctx, pr); return pr })
    round.pulls.set(number, read)
  }
  return read
}
async function intakeComments(ctx: SourceContext, ref: PullRef, since: string, round: Round): Promise<void> {
  const commands = ctx.commands.withSignal(round.signal)
  const { login } = ctx.deployment.github
  const kinds = ref.isPr ? ['conversation', 'inline', 'review'] as const : ['conversation'] as const
  for (const kind of kinds) {
    const suffix = `&since=${encodeURIComponent(since)}`
    const path = kind === 'conversation' ? `issues/${ref.number}/comments?per_page=100${suffix}` : kind === 'inline' ? `pulls/${ref.number}/comments?per_page=100${suffix}` : `pulls/${ref.number}/reviews?per_page=100`
    const comments = await commands.pages(CommentSchema, path, round.tally)
    for (const comment of comments) {
      // Stopping mid-read throws so the thread's cursor stays where it was.
      if (stopped(ctx, round)) throw new Error('The GitHub Source stopped during the poll')
      const timestamp = Date.parse(comment.updated_at ?? comment.submitted_at ?? comment.created_at ?? '')
      if (!Number.isFinite(timestamp) || timestamp < Date.parse(since)) continue
      if (sameName(comment.user.login, login)) continue
      // A review decision without a body still reaches the ticket: a worker may be waiting for that approval.
      const trigger = commentTrigger(comment, ref, kind, login)
      if (trigger.text) await ctx.receive(trigger)
    }
  }
}
export async function pollTicketPulls(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  const numbers = [...new Set(ctx.tickets.open().flatMap(ticket => pullsOf(ticket, true)))]
  for (const number of numbers) {
    if (stopped(ctx, round)) return
    try {
      const pr = await pull(ctx, round, number)
      if (pr.state !== 'closed' && !pr.merged) await pollChecks(ctx, round, number, pr)
    } catch (error) { if (!stopped(ctx, round)) failed(ctx, round, number, error) }
  }
}
/** Polls a PR's CI checks; only changes after the first baseline observation become Triggers. */
async function pollChecks(ctx: SourceContext, round: Round, number: number, pr: Pull): Promise<void> {
  const snapshot = await pullChecks(ctx.commands.withSignal(round.signal), pr.head.sha, round.tally)
  const fingerprint = key(JSON.stringify(snapshot))
  const previous = ctx.state.get(KV.github.ci(number))
  if (previous?.fingerprint === fingerprint) return
  const revision = previous ? previous.revision + 1 : 0
  if (previous) await ctx.receive(ciTrigger(pr, revision, ciSummary(snapshot, `PR #${number}`, `github/pulls/${number}/checks`)))
  ctx.state.set(KV.github.ci(number), { fingerprint, revision })
  ctx.threads.describe(`github:${number}`, { facts: { ci: ciFact(ciCounts(snapshot)) } })
}
/** Polls subscribed Issue and PR Threads not already read in this round; a deleted (410) Issue is still polled within the horizon (costing one read) and does not fail the round. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) {
      if (stopped(ctx, round)) throw error
      if (deleted(error)) round.dropped.push(Number(thread.ref.id)); else round.failures.push(`${thread.key}: ${String(error)}`)
      throw error
    }
  }, thread => round.read.has(Number(thread.ref.id)))
}
async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  // The default branch's CI Thread has no Issue or PR to read; its CI arrives as Triggers.
  if (thread.ref.id.startsWith('ci:')) return
  const number = Number(thread.ref.id)
  if (!number) throw new Error('Subscribed thread has no GitHub issue or PR number')
  round.read.add(number)
  if (typeof thread.meta.isPr !== 'boolean' || typeof thread.meta.title !== 'string') {
    const issue = await ctx.commands.withSignal(round.signal).api(IssueSchema, `issues/${number}`)
    ctx.threads.patch(thread.key, { number, isPr: !!issue.pull_request, url: issue.html_url })
    if (issue.title) nameThread(ctx, number, issue.title)
    thread = ctx.threads.get(thread.key) ?? thread
  }
  const checkpoint = KV.github.cursor(number)
  const since = ctx.state.get(checkpoint) ?? thread.createdAt
  if (thread.meta.isPr === true) {
    const pr = await pull(ctx, round, number)
    await intakeComments(ctx, { number, isPr: true, url: pr.html_url, prAuthor: pr.user.login }, since, round)
  } else await intakeComments(ctx, { number, isPr: false }, since, round)
  ctx.state.set(checkpoint, cursorAt(round.started))
}
