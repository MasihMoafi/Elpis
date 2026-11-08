// Ported from dsh-superagent (MIT), src/sources/github-pull.ts
/** Pull request binding, lifecycle observation, and terminal IM notification helpers. */
import { z } from "zod";
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from "../core/index.mts";
import type { Deployment } from "../infra/types.mts";
import { sameName } from "../infra/text.mts";
import type { SourceContext } from "./host.mts";
import { githubPage, SOURCE, UserSchema } from "./github-trigger.mts";

const PullSchema = z.looseObject({
  title: z.string().optional(),
  state: z.string(),
  html_url: z.string(),
  user: UserSchema,
  body: z.string().nullish(),
  created_at: z.string().optional(),
  merged: z.boolean().optional(),
  merged_at: z.string().nullish(),
  closed_at: z.string().nullish(),
  auto_merge: z.unknown().optional(),
  head: z.looseObject({ sha: z.string(), ref: z.string(), repo: z.looseObject({ full_name: z.string() }).nullish() }),
});
export type Pull = z.infer<typeof PullSchema> & { number: number };
export const readPull = async (ctx: SourceContext, number: number, signal?: AbortSignal): Promise<Pull> => ({
  ...(await ctx.commands.withSignal(signal).api(PullSchema, `pulls/${number}`)),
  number,
});
const pullNumber = (thread: string): number | undefined =>
  thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) : undefined;
export const pullsOf = (ticket: Pick<Ticket, "follows">, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? []);
export const pullOf = (ticket: Pick<Ticket, "follows">): number | undefined =>
  pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1);
/** True when the PR was opened by the agent account from a branch in the configured repository (not a fork). */
export const agentPull = (
  pr: { user: { login: string }; head?: { repo?: { full_name: string } | null | undefined } | null | undefined },
  deployment: Pick<Deployment, "github" | "repository">,
): boolean =>
  sameName(pr.user.login, deployment.github.login) && sameName(pr.head?.repo?.full_name ?? "", deployment.repository);
/** True when a branch belongs to the ticket: its last path segment is the ticket's short name, such as `agent/<name>`. */
export const ticketBranch = (ticket: Pick<Ticket, "execution">, ref: string): boolean =>
  !!ticket.execution?.name && ref.split("/").at(-1) === ticket.execution.name;
const AUTO_MERGE_ON: ThreadFact = { label: { zh: "自动合并", en: "Auto-merge" }, value: { zh: "已开启", en: "on" } };

/**
 * Validates and binds an open PR to a ticket when the PR is either the ticket's origin PR or an agent-authored PR on the ticket's branch, enforcing that one PR binds to at most one open ticket.
 * Returns an error message when binding is rejected, or undefined when the PR is bound or when the PR is not open (which is not an error).
 */
export function claimPull(ctx: SourceContext, ticketId: string, pr: Pull): string | undefined {
  const ticket = ctx.tickets.get(ticketId);
  if (!ticket || !liveTicket(ticket)) return "Ticket ended because its PR was closed";
  const source = ctx.triggers.get(ticket.origin.triggerId);
  const started = source?.source === SOURCE && source.meta.isPr === true && source.meta.number === pr.number;
  const opened = agentPull(pr, ctx.deployment) && ticketBranch(ticket, pr.head.ref);
  if (!started && !opened) {
    const { login } = ctx.deployment.github;
    return `PR does not belong to this ticket: use the source PR or a PR by ${login} from a branch whose last path segment is DSH_SUPERAGENT_NAME; omit pr_number when no PR exists`;
  }
  const owner = ctx.tickets.open().find(item => pullsOf(item, true).includes(pr.number));
  if (owner && owner.id !== ticketId) return "PR already belongs to another active ticket";
  const follow = ticket.follows?.find(item => item.thread === `${SOURCE}:${pr.number}`);
  if (pr.state === "open" && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, pr, opened);
  return undefined;
}
/**
 * Reconciles a polled PR's open/merged/closed state and auto-merge fact with any bound or branch-matching ticket.
 * An open agent PR auto-binds to the single open ticket on its branch unless that ticket already follows another open PR
 * (which only the Executor's report changes).
 * @returns whether the PR has ended.
 */
export function observePull(ctx: SourceContext, pr: Pull): boolean {
  const ended = pr.state === "closed" || !!pr.merged;
  if (ended) closePull(ctx, pr);
  else {
    const candidates = agentPull(pr, ctx.deployment)
      ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, pr.head.ref))
      : [];
    const ticket = candidates.length === 1 ? candidates[0]! : undefined;
    // A PR the ticket followed until it closed, and that is open again, is followed again.
    const reopened = ticket?.follows?.some(item => item.thread === `${SOURCE}:${pr.number}` && item.closed);
    if (ticket && (reopened || pullsOf(ticket, true).every(number => number === pr.number)))
      claimPull(ctx, ticket.id, pr);
  }
  ctx.threads.describe(`github:${pr.number}`, {
    facts: { autoMerge: !ended && pr.auto_merge != null ? AUTO_MERGE_ON : null },
  });
  return ended;
}
function bind(ctx: SourceContext, ticketId: string, pr: Pull, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: String(pr.number) }, own);
    ctx.threads.patch(`github:${pr.number}`, {
      number: pr.number,
      isPr: true,
      url: pr.html_url,
      prAuthor: pr.user.login,
    });
  });
}
/**
 * Reports a merged or closed PR once to the open tickets that follow it, whose end the core decides.
 * Their subscription to the PR stays so a later human comment there resumes the ticket.
 */
function closePull(ctx: SourceContext, pr: Pull): void {
  if (!ctx.tickets.open().some(ticket => pullsOf(ticket, true).includes(pr.number))) return;
  const at = pr.merged_at ?? pr.closed_at ?? new Date().toISOString();
  ctx.tickets.threadClosed({ source: SOURCE, id: String(pr.number) }, pr.merged ? "merged" : "closed", at);
}
/**
 * Builds idempotent outbound notices for IM conversations when a ticket ends with its PR (selecting the last-closed PR it
 * opened, else the last one it followed). The notice language follows the ticket's source request: Chinese when it contains
 * Han characters and no kana, otherwise English.
 */
export function pullEndNotices(ticket: Ticket, request: string, repository: string): OutboundMessage[] {
  const outcome = ticket.ended?.outcome;
  const follows = (ticket.follows ?? []).filter(item => item.closed && pullNumber(item.thread) !== undefined);
  const latest = (items: Follow[]) => items.sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0];
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows);
  if ((outcome !== "merged" && outcome !== "closed") || !follow) return [];
  const number = pullNumber(follow.thread)!;
  const url = githubPage(repository, number, true);
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request);
  const text = chinese
    ? outcome === "merged"
      ? `[PR #${number}](${url}) 已合并。`
      : `[PR #${number}](${url}) 已关闭，未合并。`
    : outcome === "merged"
      ? `[PR #${number}](${url}) has merged.`
      : `[PR #${number}](${url}) was closed without merging.`;
  // GitHub timelines and linked issues already show the merge or closure, so GitHub channels are skipped.
  return ticket.channels
    .filter(channel => channel.source !== SOURCE)
    .map(channel => ({
      id: key("pr-terminal", String(number), channel.source, JSON.stringify(channel.address), outcome),
      channel,
      text,
      kind: "notice",
      ticketId: ticket.id,
    }));
}
