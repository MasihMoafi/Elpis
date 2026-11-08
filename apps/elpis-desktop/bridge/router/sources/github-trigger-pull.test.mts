// Ported from dsh-superagent (MIT), tests/sources.spec.ts
import { it } from "node:test";
import { expect } from "expect";
import { commentTrigger, githubAddress, type GithubComment } from "./github-trigger.mts";
import { ticketBranch } from "./github-pull.mts";
import { ciCounts, ciFact, ciSummary } from "./github-read.mts";
const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: "" });
it("normalizes comments and reviews into triggers with review-thread channels, and marks only GitHub Apps and machine accounts as automated", () => {
  const trigger = commentTrigger(
    {
      id: 5,
      body: "nit",
      user: { login: "review-bot[bot]", type: "Bot" },
      html_url: "https://github.com/acme/widgets/pull/7#discussion_r5",
      updated_at: "2026-09-01T00:00:00Z",
    },
    { number: 7, isPr: true, prAuthor: "agent-bot" },
    "inline",
    "agent-bot",
  );
  expect(trigger).toMatchObject({
    source: "github",
    threads: [{ source: "github", id: "7" }],
    human: false,
    channel: { address: { number: "7", url: "https://github.com/acme/widgets/pull/7#discussion_r5" } },
    meta: { commentId: 5, kind: "inline", prAuthor: "agent-bot" },
  });
  // A review bot on an ordinary account counts as a person here; the prompts name it as automated.
  expect(
    commentTrigger(
      { id: 6, body: "x", user: { login: "review-bot", type: "User" } },
      { number: 7, isPr: false },
      "conversation",
      "agent-bot",
    ).human,
  ).toBe(true);
  expect(
    commentTrigger(
      { id: 7, body: "x", user: { login: "ci[bot]", type: "Bot" } },
      { number: 7, isPr: false },
      "conversation",
      "agent-bot",
    ).human,
  ).toBe(false);
  // A review decision reaches the ticket even without a body; a plain review comment carries only its body.
  const review = (fields: Partial<GithubComment>) =>
    commentTrigger(
      { id: 8, user: { login: "carol", type: "User" }, submitted_at: "2026-09-01T00:00:00Z", ...fields },
      { number: 7, isPr: true },
      "review",
      "agent-bot",
    ).text;
  expect(review({ state: "APPROVED", commit_id: "abc123" })).toBe("APPROVED review of commit abc123");
  expect(review({ state: "CHANGES_REQUESTED", commit_id: "abc123", body: "Keep the margin" })).toBe(
    "CHANGES_REQUESTED review of commit abc123\n\nKeep the margin",
  );
  expect(review({ state: "COMMENTED", commit_id: "abc123" })).toBe("");
  // A mention of the agent addresses it, whatever the case; the agent's own messages are automated.
  expect(
    commentTrigger(
      { id: 9, body: "@Agent-Bot please fix", user: { login: "alice", type: "User" } },
      { number: 7, isPr: true },
      "conversation",
      "agent-bot",
    ),
  ).toMatchObject({ human: true, addressed: "mention" });
  expect(
    commentTrigger(
      { id: 10, body: "mail@agent-bot.example", user: { login: "alice", type: "User" } },
      { number: 7, isPr: true },
      "conversation",
      "agent-bot",
    ),
  ).not.toHaveProperty("addressed");
  expect(
    commentTrigger(
      { id: 11, body: "pushed", user: { login: "Agent-Bot", type: "User" } },
      { number: 7, isPr: true },
      "conversation",
      "agent-bot",
    ).human,
  ).toBe(false);
});
it("reads the address of an Issue, a PR or a review comment of the repository, and nothing else", () => {
  expect(githubAddress("https://api.github.com/repos/acme/widgets/pulls/9", "acme/widgets")).toEqual({
    number: 9,
    pr: true,
  });
  expect(githubAddress("https://api.github.com/repos/Acme/Widgets/issues/12", "acme/widgets")).toEqual({
    number: 12,
    pr: false,
  });
  expect(githubAddress("https://github.com/acme/widgets/pull/7/#discussion_r5", "acme/widgets")).toEqual({
    number: 7,
    pr: true,
    discussion: 5,
  });
  expect(githubAddress("https://github.com/acme/widgets/issues/7#issuecomment-3", "acme/widgets")).toEqual({
    number: 7,
    pr: false,
  });
  for (const url of [
    "https://github.com/acme/gadgets/pull/7",
    "https://api.github.com/repos/acme/widgets/commits/abc",
    "https://github.com/acme/widgets/pull/7/files",
    "",
  ]) {
    expect(githubAddress(url, "acme/widgets")).toBeUndefined();
  }
});
it("matches a branch to a ticket by its short name as the last path segment", () => {
  expect(ticketBranch({ execution: execution("fix-title-1a2b3c") }, "agent/fix-title-1a2b3c")).toBe(true);
  expect(ticketBranch({ execution: execution("fix-title-1a2b3c") }, "fix-title-1a2b3c")).toBe(true);
  expect(ticketBranch({ execution: execution("fix-title-1a2b3c") }, "agent/fix-title-1a2b3c-2")).toBe(false);
  expect(ticketBranch({}, "agent/x")).toBe(false);
});
it("describes CI as one fact: failed checks first, then unfinished ones, otherwise passed", () => {
  const counts = ciCounts({
    head: "abc",
    checks: [
      { name: "e2e", status: "completed", conclusion: "failure" },
      { name: "lint", status: "in_progress", conclusion: null },
      { name: "docs", status: "completed", conclusion: "skipped" },
    ],
    statuses: [
      { context: "deploy", state: "error" },
      { context: "preview", state: "pending" },
    ],
  });
  expect(counts).toEqual({ failed: 2, running: 2 });
  expect(ciFact(counts)).toEqual({ label: { zh: "CI 失败", en: "CI failed" }, value: "2", problem: true });
  expect(ciFact({ failed: 0, running: 1 })).toEqual({ label: { zh: "CI 进行中", en: "CI running" }, value: "1" });
  expect(ciFact({ failed: 0, running: 0 })).toEqual({ label: "CI", value: { zh: "通过", en: "passed" } });
});
it("starts a review comment's text with its file, line and diff lines, and keeps them and the comment it answers", () => {
  const comment: GithubComment = {
    id: 5,
    body: "Use the theme token",
    user: { login: "carol", type: "User" },
    path: "src/render.ts",
    line: 43,
    diff_hunk: "@@ -40,6 +40,8 @@\n   const title = view.title\n   const margin = 12\n+  const padding = 8",
    in_reply_to_id: 4,
    html_url: "https://github.com/acme/widgets/pull/9#discussion_r5",
    created_at: "2026-09-09T00:00:00Z",
  };
  const trigger = commentTrigger(comment, { number: 9, isPr: true }, "inline", "agent-bot");
  expect(trigger.text).toBe(
    "src/render.ts:43\n   const title = view.title\n   const margin = 12\n+  const padding = 8\n\nUse the theme token",
  );
  expect(trigger.meta).toMatchObject({ path: "src/render.ts", line: 43, inReplyTo: 4, commentId: 5, kind: "inline" });
});
it("starts a CI Trigger's text with what failed or still runs, so its preview says it", () => {
  const check = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
  const failing = {
    head: "abc1234def",
    checks: [
      check("lint", "completed", "failure"),
      check("e2e", "completed", "timed_out"),
      check("unit", "completed", "success"),
      check("docs", "in_progress", null),
    ],
    statuses: [],
  };
  const read = "github/pulls/9/checks";
  expect(ciSummary(failing, "PR #9", read)).toBe(
    "CI failed 2/4 on PR #9 at abc1234: lint, e2e; 1 still running\nRead github/pulls/9/checks for every check.",
  );
  expect(ciSummary({ ...failing, checks: [check("docs", "queued", null)] }, "PR #9", read)).toMatch(
    /^CI running 1\/1 on PR #9 at abc1234: docs/,
  );
  expect(ciSummary({ ...failing, checks: [check("unit", "completed", "success")] }, "PR #9", read)).toMatch(
    /^CI passed 1\/1 on PR #9 at abc1234/,
  );
});
