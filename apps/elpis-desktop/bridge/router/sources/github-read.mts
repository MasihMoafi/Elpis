// Ported from dsh-superagent (MIT), src/sources/github-read.ts
/** Read-only GitHub repository, conversation, and CI check inspection for assessments and workers. */
import { z } from "zod";
import type { ThreadFact } from "../core/index.mts";
import { validItems, type Commands, type Tally } from "../infra/commands.mts";
import { CommentSchema, IssueSchema, isHumanLogin, reviewPlace, type GithubComment } from "./github-trigger.mts";
import type { ContextMessage, ThreadContext } from "./kind.mts";

const CheckSchema = z.looseObject({ name: z.string(), status: z.string(), conclusion: z.string().nullable() });
const StatusSchema = z.looseObject({ context: z.string(), state: z.string() });
type Check = Pick<z.infer<typeof CheckSchema>, "name" | "status" | "conclusion">;
type Status = Pick<z.infer<typeof StatusSchema>, "context" | "state">;

export interface CiSnapshot {
  head: string;
  checks: Check[];
  statuses: Status[];
}
/** Check conclusions and status states that count as failures; `success`, `neutral`, `skipped`, and `stale` do not. */
const FAILING = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure", "error"]);
export function ciCounts(snapshot: CiSnapshot): { failed: number; running: number } {
  const statuses = snapshot.statuses ?? [];
  return {
    failed:
      snapshot.checks.filter(check => FAILING.has(check.conclusion ?? "")).length +
      statuses.filter(status => FAILING.has(status.state)).length,
    running:
      snapshot.checks.filter(check => check.status !== "completed").length +
      statuses.filter(status => status.state === "pending").length,
  };
}
export function ciSummary(snapshot: CiSnapshot, where: string, read: string): string {
  const checks = snapshot.checks.map(check => ({
    name: check.name,
    failed: FAILING.has(check.conclusion ?? ""),
    running: check.status !== "completed",
  }));
  const statuses = (snapshot.statuses ?? []).map(status => ({
    name: status.context,
    failed: FAILING.has(status.state),
    running: status.state === "pending",
  }));
  const results = [...checks, ...statuses];
  const failed = results.filter(result => result.failed).map(result => result.name);
  const running = results.filter(result => result.running).map(result => result.name);
  const names = (list: string[]) =>
    list.slice(0, 5).join(", ") + (list.length > 5 ? `, and ${list.length - 5} more` : "");
  const at = `on ${where} at ${snapshot.head.slice(0, 7)}`;
  const still = running.length ? `; ${running.length} still running` : "";
  const line = failed.length
    ? `CI failed ${failed.length}/${results.length} ${at}: ${names(failed)}${still}`
    : running.length
      ? `CI running ${running.length}/${results.length} ${at}: ${names(running)}`
      : `CI passed ${results.length}/${results.length} ${at}`;
  return `${line}\nRead ${read} for every check.`;
}
export function ciFailures(snapshot: CiSnapshot): string[] {
  return [
    ...snapshot.checks.filter(check => FAILING.has(check.conclusion ?? "")).map(check => check.name),
    ...(snapshot.statuses ?? []).filter(status => FAILING.has(status.state)).map(status => status.context),
  ].sort();
}
export function ciFact(counts: { failed: number; running: number }): ThreadFact {
  if (counts.failed) return { label: { zh: "CI 失败", en: "CI failed" }, value: String(counts.failed), problem: true };
  if (counts.running) return { label: { zh: "CI 进行中", en: "CI running" }, value: String(counts.running) };
  return { label: "CI", value: { zh: "通过", en: "passed" } };
}

/** Reads a non-hidden file or directory listing from the repository's default branch via the GitHub API; hidden entries and `node_modules` are rejected. */
export async function readRepositoryPath(
  commands: Commands,
  path: string,
  kind: "file" | "directory",
): Promise<string> {
  const parts = path.split("/").filter(part => part && part !== ".");
  if (parts.some(part => part === ".." || part.startsWith(".") || part === "node_modules"))
    throw new Error("Only non-hidden repository source paths are available");
  const resource = `contents/${parts.map(encodeURIComponent).join("/")}`;
  if (kind === "file") return commands.api(resource, "-H", "Accept: application/vnd.github.raw");
  // GitHub returns an entry array for a directory and a single object for a file.
  const entries = await commands.api(
    z.union([z.array(z.looseObject({ name: z.string() })), z.looseObject({})]),
    resource,
  );
  if (!Array.isArray(entries)) throw new Error(`${path} is not a directory`);
  return entries
    .map(entry => entry.name)
    .filter(name => !name.startsWith(".") && name !== "node_modules")
    .sort()
    .join("\n");
}

/** Reads check runs and commit statuses for a commit without emitting a trigger. */
export async function pullChecks(commands: Commands, head: string, tally?: Tally): Promise<CiSnapshot> {
  const page = z.looseObject({ check_runs: z.array(z.unknown()) });
  const pages = await commands.api(z.array(page), `commits/${head}/check-runs?per_page=100`, "--paginate", "--slurp");
  const runs = validItems(
    CheckSchema,
    pages.flatMap(page => page.check_runs),
    tally,
  );
  const statuses = await commands.pages(StatusSchema, `commits/${head}/statuses?per_page=100`, tally);
  const latest = new Map<string, string>();
  for (const status of statuses) if (!latest.has(status.context)) latest.set(status.context, status.state);
  const checks = runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }));
  return {
    head,
    checks: checks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    statuses: [...latest]
      .map(([context, state]) => ({ context, state }))
      .sort((a, b) => a.context.localeCompare(b.context)),
  };
}

/** Formats a GitHub comment, review, or issue as a model-facing ContextMessage, marking bots and GitHub Apps because bot messages never authorize work. */
function githubMessage(item: GithubComment, text: string, id: string): ContextMessage {
  const line = item.line ?? item.original_line;
  return {
    id,
    from: item.user.login,
    at: item.created_at ?? item.submitted_at ?? "",
    text,
    ...(!isHumanLogin(item.user) ? { bot: true } : {}),
    ...(item.html_url ? { url: item.html_url } : {}),
    ...(item.path ? { path: item.path, ...(line != null ? { line } : {}) } : {}),
  };
}
const reviewText = (review: GithubComment): string =>
  [review.state && review.state !== "COMMENTED" ? review.state : "", review.body ?? ""].filter(Boolean).join("\n\n");
const DescriptionSchema = IssueSchema.extend({
  labels: z.array(z.looseObject({ name: z.string() })).nullish(),
  draft: z.boolean().nullish(),
  merged: z.boolean().nullish(),
  head: z.looseObject({ ref: z.string() }).nullish(),
  base: z.looseObject({ ref: z.string() }).nullish(),
});
async function reviewThread(
  commands: Commands,
  number: number,
  comment: number,
  tally?: Tally,
): Promise<GithubComment[]> {
  const comments = await commands.pages(CommentSchema, `pulls/${number}/comments?per_page=100`, tally);
  const root = comments.find(item => item.id === comment)?.in_reply_to_id ?? comment;
  return comments
    .filter(item => item.id === root || item.in_reply_to_id === root)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""));
}
function threadMessages(thread: GithubComment[], id: (comment: GithubComment) => string): ContextMessage[] {
  const [first] = thread;
  return thread.map(item =>
    item === first
      ? githubMessage(item, [reviewPlace(item), item.body ?? ""].filter(Boolean).join("\n\n"), id(item))
      : { ...githubMessage(item, item.body ?? "", id(item)), ...(first ? { reply_to: id(first) } : {}) },
  );
}

/**
 * Reads an Issue or PR, a page of its comments or reviews, a review thread, or a CI snapshot as model-facing
 * `{ id, from, at, text, reply_to?, path?, line?, url }` messages rather than raw GitHub API records.
 */
export async function readGithub(commands: Commands, resource: string): Promise<unknown> {
  // A commit's CI, such as the default branch's, which no PR names.
  const commit = /^github\/commits\/([0-9a-f]{7,40})\/checks$/.exec(resource);
  if (commit) return pullChecks(commands, commit[1]!);
  const match = /^github\/(issues|pulls)\/([1-9]\d*)(?:\/(comments|reviews|checks|thread)(?:\/([1-9]\d*))?)?$/.exec(
    resource,
  );
  if (!match) {
    throw new Error(
      "Use github/issues/<number>, github/pulls/<number>, or append /comments/<page>, /reviews/<page>, /thread/<comment-id> or /checks; or github/commits/<sha>/checks",
    );
  }
  const [, kind, number, section, page = "1"] = match;
  if (kind === "issues" && (section === "reviews" || section === "checks" || section === "thread")) {
    throw new Error("Reviews, review threads and checks require a pull request");
  }
  const path = `${kind}/${number}`;
  if (section === "checks") {
    if (match[4]) throw new Error("Checks do not take a page number");
    const pr = await commands.api(z.looseObject({ head: z.looseObject({ sha: z.string() }) }), path);
    return pullChecks(commands, pr.head.sha);
  }
  if (section === "thread") {
    if (!match[4])
      throw new Error("Name the review thread by one of its comments: github/pulls/<number>/thread/<comment-id>");
    const thread = await reviewThread(commands, Number(number), Number(match[4]));
    if (!thread.length) throw new Error("No review comment of this PR has that id");
    return { messages: threadMessages(thread, item => String(item.id)) };
  }
  if (!section) {
    const item = await commands.api(DescriptionSchema, path);
    const branches = item.head && item.base ? { head: item.head.ref, base: item.base.ref } : {};
    const labels = item.labels?.length ? { labels: item.labels.map(label => label.name) } : {};
    return {
      number: item.number,
      title: item.title,
      state: item.state,
      ...(item.merged ? { merged: true } : {}),
      ...(item.draft ? { draft: true } : {}),
      ...branches,
      ...labels,
      ...githubMessage(item, item.body ?? "", String(item.number)),
    };
  }
  const listed = await commands.api(z.array(z.unknown()), `${path}/${section}?per_page=20&page=${page}`);
  const tally = { skipped: 0 };
  const items = validItems(CommentSchema, listed, tally);
  const messages = items.map(item =>
    section === "reviews"
      ? githubMessage({ ...item, created_at: item.submitted_at ?? item.created_at }, reviewText(item), String(item.id))
      : {
          ...githubMessage(item, item.body ?? "", String(item.id)),
          ...(item.in_reply_to_id ? { reply_to: String(item.in_reply_to_id) } : {}),
        },
  );
  return {
    messages,
    ...(tally.skipped ? { skipped: tally.skipped } : {}),
    ...(listed.length === 20 ? { next_resource: `github/${kind}/${number}/${section}/${Number(page) + 1}` } : {}),
  };
}
/** Reads one page of an Issue or PR conversation (with the Issue/PR description first on page 1), using comment URLs as message IDs. */
async function conversationPage(commands: Commands, number: number, page: number) {
  const messages: ContextMessage[] = [];
  if (page === 1) {
    const issue = await commands.api(IssueSchema, `issues/${number}`);
    messages.push(githubMessage(issue, `${issue.title}\n\n${issue.body ?? ""}`, issue.html_url));
  }
  const listed = await commands.api(z.array(z.unknown()), `issues/${number}/comments?per_page=100&page=${page}`);
  const tally = { skipped: 0 };
  const comments = validItems(CommentSchema, listed, tally);
  messages.push(
    ...comments.map(comment => githubMessage(comment, comment.body ?? "", comment.html_url ?? String(comment.id))),
  );
  return {
    messages,
    next_resource: listed.length === 100 ? String(page + 1) : null,
    ...(tally.skipped ? { skipped: tally.skipped } : {}),
  };
}
/**
 * Context reader for a GitHub Trigger: reads the review thread for an inline review comment (whose first comment is its
 * root and parent), or the Issue/PR conversation by page otherwise (whose first page is its root and parent).
 */
export const githubThreadContext: ThreadContext<unknown> = {
  messageId: trigger => trigger.url ?? "",
  read: async (commands, trigger, part, cursor) => {
    // The default branch's CI has no conversation; its Trigger is its context.
    if (typeof trigger.meta.branch === "string") {
      const message = {
        id: trigger.url ?? trigger.id,
        from: "CI",
        at: trigger.at,
        text: trigger.text,
        bot: true as const,
      };
      return { messages: [message], body: { status: "branch_ci", messages: [message] }, status: "branch_ci" };
    }
    const number = Number(trigger.meta.number);
    if (trigger.meta.kind === "inline" && typeof trigger.meta.commentId === "number") {
      const thread = await reviewThread(commands, number, trigger.meta.commentId);
      const messages = threadMessages(thread, item => item.html_url ?? String(item.id));
      const read = part === "thread" ? messages : messages.slice(0, 1);
      return { messages: read, body: { status: "review_thread", messages: read }, status: "review_thread" };
    }
    const body = await conversationPage(commands, number, Number(cursor ?? "1"));
    return { messages: body.messages, next: body.next_resource ?? undefined, body };
  },
};
