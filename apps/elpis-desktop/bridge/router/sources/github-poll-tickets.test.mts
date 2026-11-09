import { describe, it } from "node:test";
import { expect } from "expect";
import { vi } from "../test-support.mts";
import { feishuTrigger } from "../fixtures/chat-kind.mts";
import { commentTrigger, githubAddress, githubChannel, type GithubComment } from "./github-trigger.mts";
import { claimPull, observePull, pullEndNotices, pullOf, ticketBranch, type Pull } from "./github-pull.mts";
import { ciCounts, ciFact, ciSummary } from "./github-read.mts";
import { MEMBER, host, openTicket, execution, pulled, endedPull, agentsPull, openPull } from "./github-poll.fixtures.mts";

describe("github source", () => {
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
  it("gives an assessment of a review comment the earlier comments of its review thread", async () => {
    const h = host();
    const comment = (id: number, reply?: number) => ({
      id,
      body: `comment ${id}`,
      user: { login: "carol", type: "User" },
      path: "src/render.ts",
      line: 43,
      html_url: `https://github.com/acme/widgets/pull/9#discussion_r${id}`,
      created_at: `2026-09-09T00:00:0${id}Z`,
      ...(reply ? { in_reply_to_id: reply } : {}),
    });
    vi.spyOn(h.commands, "pages").mockResolvedValue([comment(1), comment(2, 1), comment(3), comment(4, 1)]);
    const trigger = commentTrigger(comment(4, 1), { number: 9, isPr: true }, "inline", "agent-bot");
    const context = h.sources.threadContext(trigger)!;
    const thread = await context.read(h.commands, "thread");
    expect(thread).toMatchObject({ status: "review_thread" });
    expect(thread.messages.map(message => message.id)).toEqual(
      [1, 2, 4].map(id => `https://github.com/acme/widgets/pull/9#discussion_r${id}`),
    );
    expect(context.messageId).toBe(thread.messages[2]!.id);
    expect((await context.read(h.commands, "parent")).messages.map(message => message.id)).toEqual([
      thread.messages[0]!.id,
    ]);
    h.store.close();
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
  it("binds a PR to the unique live ticket on its branch and ends tickets when the PR closes", async () => {
    const h = host();
    const decisionId = "d";
    const request = feishuTrigger(
      {
        message_id: "om_1",
        chat_id: "oc_1",
        chat_type: "group",
        sender_id: MEMBER,
        sender_type: "user",
        content: "@bot 修一下标题",
        create_time: "1",
        mentions: [{ id: "ou_bot" }],
      },
      "ou_bot",
      "cli_bot",
    )!;
    h.store.triggers.save(request);
    h.store.tickets.save({
      id: "t1",
      title: "one",
      decisionId,
      mandate: {
        strength: "explicit",
        policyVersion: "",
        basis: { via: "listed" },
        actor: { source: "feishu", id: MEMBER },
        scope: "",
      },
      channels: [{ source: "feishu", thread: "feishu:oc_1", address: { chatId: "oc_1", messageId: "om_1" } }],
      assignments: [{ id: "a", state: "running", createdAt: "" }],
      inputs: [],
      undelivered: [],
      createdAt: "",
      updatedAt: "",
      execution: execution("one"),
      origin: { triggerId: request.id, triggerIds: [request.id] },
    });
    const agentsPull = (number: number): Pull => ({
      ...openPull(number),
      user: { login: "agent-bot" },
      head: { sha: "abc", ref: "agent/one", repo: { full_name: "acme/widgets" } },
    });
    observePull(h, agentsPull(9));
    expect(pullOf(h.store.tickets.get("t1")!)).toBe(9);
    expect(h.store.threads.get("github:9")?.subscriptions).toEqual(["t1"]);
    // A ticket that follows a PR moves to another only by its Executor's report.
    observePull(h, agentsPull(10));
    expect(pullOf(h.store.tickets.get("t1")!)).toBe(9);
    expect(observePull(h, endedPull(9, "2026-09-02T00:00:00Z"))).toBe(true);
    expect(h.store.tickets.get("t1")).toMatchObject({
      ended: { by: "executor", outcome: "merged", at: "2026-09-02T00:00:00.000Z" },
    });
    expect(h.store.threads.get("github:9")?.subscriptions).toEqual(["t1"]);
    // The notice its end gives follows the language of the source request.
    const notices = pullEndNotices(h.store.tickets.get("t1")!, request.text, "acme/widgets");
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "notice",
        channel: expect.objectContaining({ source: "feishu" }),
        text: expect.stringContaining("已合并"),
      }),
    ]);
    expect(h.executor.stop).toHaveBeenCalledTimes(1);
    // Resumed after the merge, the ticket works on: a later look at the merged PR reports nothing again.
    const resumed = { ...h.store.tickets.get("t1")! };
    delete resumed.ended;
    h.store.tickets.save({
      ...resumed,
      assignments: [
        ...h.store.tickets.get("t1")!.assignments,
        { id: "a2", state: "pending", createdAt: "2026-09-03T00:00:00Z" },
      ],
    });
    expect(observePull(h, endedPull(9, "2026-09-02T00:00:00Z"))).toBe(true);
    expect(h.store.tickets.get("t1")!.ended).toBeUndefined();
    // Once the resumed work reports ready, the ticket ends with the merged PR, at that time and without a second notice.
    h.engine.report("t1", { state: "ready", summary: "answered" });
    expect(h.store.tickets.get("t1")).toMatchObject({ ended: { outcome: "merged" } });
    expect(Date.parse(h.store.tickets.get("t1")!.ended!.at)).toBeGreaterThan(Date.parse("2026-09-03T00:00:00Z"));
    // Its notice has the id of the first one, so it goes out once.
    expect(pullEndNotices(h.store.tickets.get("t1")!, request.text, "acme/widgets").map(notice => notice.id)).toEqual(
      notices.map(notice => notice.id),
    );
    h.store.close();
  });
  it("keeps a ticket working on its other open PR when one of its PRs merges", async () => {
    const h = host();
    h.store.tickets.save({
      id: "t3",
      title: "three",
      decisionId: "d3",
      mandate: {
        strength: "explicit",
        policyVersion: "",
        basis: { via: "listed" },
        actor: { source: "feishu", id: MEMBER },
        scope: "",
      },
      channels: [],
      assignments: [{ id: "a1", state: "running", createdAt: "2026-09-01T00:00:00Z" }],
      inputs: [],
      undelivered: [],
      execution: execution("fix-3"),
      origin: { triggerId: "x", triggerIds: [] },
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    expect(claimPull(h, "t3", agentsPull(21, "agent/fix-3"))).toBeUndefined();
    expect(claimPull(h, "t3", agentsPull(22, "agent/fix-3"))).toBeUndefined();
    expect(observePull(h, endedPull(22, "2026-09-02T00:00:00Z"))).toBe(true);
    expect(h.store.tickets.get("t3")).toMatchObject({
      follows: [
        { thread: "github:21", own: true },
        { thread: "github:22", own: true, closed: { at: "2026-09-02T00:00:00.000Z", outcome: "merged" } },
      ],
    });
    expect(h.store.tickets.get("t3")).not.toHaveProperty("ended");
    expect(pullOf(h.store.tickets.get("t3")!)).toBe(21);
    expect(h.executor.stop).not.toHaveBeenCalled();
    expect(observePull(h, endedPull(21, "2026-09-03T00:00:00Z"))).toBe(true);
    expect(h.store.tickets.get("t3")).toMatchObject({ ended: { outcome: "merged", at: "2026-09-03T00:00:00.000Z" } });
    // A PR's end is kept on the tickets that follow it, so binding and closing write no key-value record.
    expect(h.store.keys("github-")).toEqual([]);
    h.store.close();
  });
  it("follows a PR it opened again when it reopens, while another PR it opened is open", async () => {
    const h = host();
    h.store.tickets.save({
      ...openTicket("t5"),
      execution: execution("fix-5"),
      follows: [
        { thread: "github:21", own: true },
        { thread: "github:22", own: true, closed: { at: "2026-09-02T00:00:00.000Z", outcome: "closed" } },
      ],
    });
    observePull(h, agentsPull(22, "agent/fix-5"));
    expect(h.store.tickets.get("t5")!.follows).toEqual([
      { thread: "github:21", own: true },
      { thread: "github:22", own: true },
    ]);
    h.store.close();
  });
  it("ends a ticket when its own PR merges, though the PR it started from is still open", async () => {
    const h = host();
    h.store.tickets.save({
      id: "t4",
      title: "four",
      decisionId: "d4",
      mandate: {
        strength: "explicit",
        policyVersion: "",
        basis: { via: "listed" },
        actor: { source: "github", id: "alice" },
        scope: "",
      },
      channels: [githubChannel(30, "https://github.com/acme/widgets/pull/30#issuecomment-1")],
      assignments: [{ id: "a1", state: "running", createdAt: "2026-09-01T00:00:00Z" }],
      inputs: [],
      undelivered: [],
      execution: execution("fix-4"),
      origin: { triggerId: "x", triggerIds: [] },
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    h.store.threads.save({
      key: "github:30",
      ref: { source: "github", id: "30" },
      createdAt: "",
      subscriptions: ["t4"],
      correlated: [],
      pending: [],
      meta: { number: 30, isPr: true },
    });
    expect(claimPull(h, "t4", agentsPull(31, "agent/fix-4"))).toBeUndefined();
    expect(observePull(h, endedPull(31, "2026-09-02T00:00:00Z"))).toBe(true);
    expect(h.store.tickets.get("t4")).toMatchObject({ ended: { outcome: "merged" } });
    h.store.close();
  });
  it("writes the terminal notice in English for a request without Han characters", async () => {
    const h = host();
    const request = feishuTrigger(
      {
        message_id: "om_2",
        chat_id: "oc_1",
        chat_type: "group",
        sender_id: MEMBER,
        sender_type: "user",
        content: "@bot fix the title",
        create_time: "1",
        mentions: [{ id: "ou_bot" }],
      },
      "ou_bot",
      "cli_bot",
    )!;
    h.store.triggers.save(request);
    h.store.tickets.save({
      id: "t2",
      title: "two",
      decisionId: "d2",
      mandate: {
        strength: "explicit",
        policyVersion: "",
        basis: { via: "listed" },
        actor: { source: "feishu", id: MEMBER },
        scope: "",
      },
      channels: [{ source: "feishu", thread: "feishu:oc_1", address: { chatId: "oc_1", messageId: "om_2" } }],
      assignments: [],
      inputs: [],
      undelivered: [],
      createdAt: "",
      updatedAt: "",
      ...pulled(12),
      origin: { triggerId: request.id, triggerIds: [request.id] },
    });
    expect(observePull(h, endedPull(12, "2026-09-02T00:00:00Z", false))).toBe(true);
    expect(pullEndNotices(h.store.tickets.get("t2")!, request.text, "acme/widgets")).toEqual([
      expect.objectContaining({
        text: "[PR #12](https://github.com/acme/widgets/pull/12) was closed without merging.",
      }),
    ]);
    h.store.close();
  });
});
