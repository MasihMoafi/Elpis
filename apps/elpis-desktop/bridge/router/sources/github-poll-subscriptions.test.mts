import { describe, it } from "node:test";
import { expect } from "expect";
import { vi } from "../test-support.mts";
import { type Thread } from "../core/index.mts";
import { issueTrigger, type GithubComment, type GithubIssue } from "./github-trigger.mts";
import { pollRound } from "./github.mts";
import { pollThreads as pollGithubThreads } from "./github.mts";
import { issue, host, subscribed, openTicket, pulled, openPull, notification, refused, github, bare } from "./github-poll.fixtures.mts";

describe("github source", () => {
  it("polls subscribed PR threads since their checkpoint and skips the bot's own comments", async () => {
    const h = host();
    const thread: Thread = {
      key: "github:7",
      ref: { source: "github", id: "7" },
      createdAt: "2026-09-01T00:00:00Z",
      lastAt: new Date().toISOString(),
      subscriptions: ["t"],
      correlated: [],
      pending: [],
      meta: { number: 7, isPr: true },
    };
    h.store.threads.save(thread);
    const comment = (id: number, login: string, at: string, body: string) => ({
      id,
      body,
      user: { login },
      created_at: at,
      updated_at: at,
    });
    github(h, {
      "issues/7": { ...issue(7, { title: "Fix the margin" }), pull_request: { url: "x" } },
      "pulls/7": openPull(7),
      "issues/7/comments": [
        comment(1, "agent-bot", "2026-09-01T01:00:00Z", "mine"),
        comment(2, "a", "2026-08-01T00:00:00Z", "old"),
        comment(3, "b", "2026-09-01T02:00:00Z", "new"),
      ],
    });
    await pollGithubThreads(h);
    expect(h.receive).toHaveBeenCalledTimes(1);
    expect(h.receive.mock.calls[0]![0]).toMatchObject({
      actor: { id: "b" },
      text: "new",
      threads: [{ source: "github", id: "7" }],
    });
    expect(h.store.get("github-cursor:7")).toBeDefined();
    // A Thread whose title the Source had not read yet is named by its number and title, with its number as a fact.
    expect(h.store.threads.get("github:7")!.meta).toMatchObject({
      title: "Fix the margin",
      label: "#7 Fix the margin",
      facts: { number: { value: "#7" } },
    });
    h.store.close();
  });
  it("polls a subscribed Thread for two weeks after the Ticket that follows it ended", async () => {
    const h = host();
    const day = 24 * 3600_000;
    h.store.threads.save({
      key: "github:7",
      ref: { source: "github", id: "7" },
      createdAt: "2026-09-01T00:00:00Z",
      lastAt: new Date(Date.now() - 30 * day).toISOString(),
      subscriptions: ["t1"],
      correlated: [],
      pending: [],
      meta: { number: 7, isPr: false, title: "Login fails" },
    });
    const ended = (ago: number) =>
      h.store.tickets.save({
        ...openTicket("t1"),
        ended: { at: new Date(Date.now() - ago).toISOString(), by: "executor", reason: "merged", outcome: "merged" },
      });
    const reads = github(h, {});
    ended(3 * day);
    await pollGithubThreads(h);
    expect(bare(reads)).toEqual(["issues/7/comments"]);
    ended(15 * day);
    await pollGithubThreads(h);
    expect(bare(reads)).toEqual(["issues/7/comments"]);
    h.store.close();
  });
  it("polls a subscribed Thread while a live ticket follows it or its last Trigger is under two weeks old", async () => {
    const h = host();
    const day = 24 * 3600_000;
    const thread = (lastAt: number, subscriptions = ["t"]) =>
      h.store.threads.save({
        key: "github:7",
        ref: { source: "github", id: "7" },
        createdAt: "2026-09-01T00:00:00Z",
        lastAt: new Date(Date.now() - lastAt).toISOString(),
        subscriptions,
        correlated: [],
        pending: [],
        meta: { number: 7, isPr: false, title: "Login fails" },
      });
    const reads = github(h, {});
    thread(15 * day);
    await pollGithubThreads(h);
    expect(reads).toEqual([]);
    thread(13 * day);
    await pollGithubThreads(h);
    expect(bare(reads)).toEqual(["issues/7/comments"]);
    // A live ticket keeps a quiet Thread polled.
    h.store.tickets.save(openTicket("t9"));
    thread(15 * day, ["t9"]);
    await pollGithubThreads(h);
    expect(bare(reads)).toEqual(["issues/7/comments", "issues/7/comments"]);
    h.store.close();
  });
  it("takes in a review decision without a body and skips a plain review comment without one", async () => {
    const h = host();
    h.store.threads.save({
      key: "github:7",
      ref: { source: "github", id: "7" },
      createdAt: "2026-09-01T00:00:00Z",
      lastAt: new Date().toISOString(),
      subscriptions: ["t"],
      correlated: [],
      pending: [],
      meta: { number: 7, isPr: true, title: "Fix the margin" },
    });
    github(h, {
      "pulls/7": openPull(7),
      "pulls/7/reviews": [
        {
          id: 4,
          state: "APPROVED",
          commit_id: "abc123",
          user: { login: "carol", type: "User" },
          submitted_at: "2026-09-02T00:00:00Z",
        },
        {
          id: 5,
          state: "COMMENTED",
          commit_id: "abc123",
          body: "",
          user: { login: "dave", type: "User" },
          submitted_at: "2026-09-02T00:01:00Z",
        },
      ],
    });
    await pollGithubThreads(h);
    expect(h.receive).toHaveBeenCalledTimes(1);
    expect(h.receive.mock.calls[0]![0]).toMatchObject({
      actor: { id: "carol" },
      text: "APPROVED review of commit abc123",
      meta: { kind: "review" },
    });
    h.store.close();
  });
  it("reads each PR once per round and takes its end, auto-merge and CI from that read", async () => {
    const h = host();
    h.store.tickets.save({ ...openTicket("t9"), ...pulled(9) });
    h.store.threads.save({
      key: "github:9",
      ref: { source: "github", id: "9" },
      createdAt: "",
      lastAt: new Date().toISOString(),
      subscriptions: ["t9"],
      correlated: [],
      pending: [],
      meta: { number: 9, isPr: true, title: "Fix" },
    });
    const pr = {
      number: 9,
      title: "Fix",
      state: "open",
      auto_merge: { merge_method: "merge" } as unknown,
      html_url: "https://github.com/acme/widgets/pull/9",
      user: { login: "agent-bot" },
      head: { sha: "abc", ref: "agent/nine", repo: { full_name: "acme/widgets" } },
    };
    const checks = { check_runs: [{ name: "test", status: "in_progress", conclusion: null }] };
    const routes: Record<string, unknown> = {
      notifications: [notification(9, "pulls")],
      "pulls/9": pr,
      "commits/abc/check-runs": checks,
    };
    const reads = github(h, routes);
    await pollRound(h);
    // The notification, the ticket's PR and the subscribed Thread share one read of the PR.
    expect(reads.filter(path => path === "pulls/9")).toHaveLength(1);
    const facts = () => h.store.threads.get("github:9")!.meta.facts as Record<string, unknown>;
    expect(facts()).toMatchObject({ autoMerge: { label: { zh: "自动合并", en: "Auto-merge" } }, ci: { value: "1" } });
    routes["pulls/9"] = { ...pr, auto_merge: null };
    routes["commits/abc/check-runs"] = { check_runs: [{ name: "test", status: "completed", conclusion: "failure" }] };
    await pollRound(h);
    expect(facts()).not.toHaveProperty("autoMerge");
    // Only a change after the first look is a Trigger.
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta)).toEqual([
      expect.objectContaining({ ci: true, revision: 1 }),
    ]);
    routes["pulls/9"] = { ...pr, state: "closed", merged: true, merged_at: "2026-09-09T00:00:00Z" };
    await pollRound(h);
    expect(h.store.tickets.get("t9")).toMatchObject({ ended: { outcome: "merged" } });
    h.store.close();
  });
  it("reads each notified Issue alone and reads a failed one again next round, from where it was", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    h.store.threads.save({
      key: "github:12",
      ref: { source: "github", id: "12" },
      createdAt: "",
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    });
    const mention = (id: number, number: number, at: string): GithubComment => ({
      id,
      body: "@agent-bot take this",
      user: { login: "alice", type: "User" },
      html_url: `https://github.com/acme/widgets/issues/${number}#issuecomment-${id}`,
      created_at: at,
      updated_at: at,
    });
    const routes: Record<string, unknown> = {
      notifications: [notification(12), notification(13)],
      "issues/12": refused(502, "Bad Gateway"),
      "issues/13": issue(13, { created_at: "2026-08-01T00:00:00Z" }),
      "issues/13/comments": [mention(1, 13, "2026-09-08T01:00:00Z")],
    };
    github(h, routes);
    // A read that failed for another reason than a missing Issue fails the round once every step ran.
    await expect(pollRound(h)).rejects.toThrow("#12: Error: gh: Bad Gateway (HTTP 502)");
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13]);
    // The cursor moved together with the Issue it does not cover yet.
    expect(Date.parse(h.store.get<string>("github-since")!)).toBeGreaterThan(Date.parse("2026-09-08T00:00:00.000Z"));
    expect(h.store.get("github-retry")).toEqual({
      12: {
        since: "2026-09-08T00:00:00.000Z",
        pr: false,
        attempts: 1,
        failedAt: expect.any(String),
        nextAt: expect.any(Number),
      },
    });
    expect(h.store.threads.get("github:12")!.meta.pollError).toContain("Bad Gateway");
    Object.assign(routes, {
      notifications: [],
      "issues/12": issue(12, { created_at: "2026-08-01T00:00:00Z" }),
      "issues/12/comments": [mention(2, 12, "2026-09-08T02:00:00Z")],
    });
    await pollRound(h);
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const retryDue = h.store.get<Record<string, { nextAt: number }>>("github-retry")!["12"]!.nextAt;
    await vi.advanceTimersByTimeAsync(retryDue - Date.now() + 1);
    await pollRound(h);
    expect(h.receive.mock.calls.map(([trigger]) => trigger.meta.number)).toEqual([13, 12]);
    expect(h.store.get("github-retry")).toEqual({});
    expect(h.store.threads.get("github:12")!.meta).not.toHaveProperty("pollError");
    h.store.close();
  });
  it("drops an Issue GitHub reports as deleted after recording it, and reads one it answers 404 for again", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    h.store.tickets.save(openTicket("t14"));
    h.store.threads.save({
      key: "github:14",
      ref: { source: "github", id: "14" },
      createdAt: "",
      lastAt: new Date().toISOString(),
      subscriptions: ["t14"],
      correlated: [],
      pending: [],
      meta: { number: 14, isPr: false, title: "Gone" },
    });
    const deleted = refused(410, "This issue was deleted");
    github(h, { notifications: [notification(14), notification(15)], "issues/14": deleted, "issues/15": deleted });
    await pollRound(h);
    expect(h.store.get("github-retry")).toEqual({});
    // Dropping a read moves no read position.
    expect(h.store.get("github-cursor:14")).toBeUndefined();
    expect(h.store.threads.get("github:14")!.meta.pollError).toContain("deleted");
    // Without a Thread to keep it, the Source's health names it.
    expect(h.health.github).toMatchObject({
      state: "ready",
      detail: "2 notifications; next poll ≥ 60s; deleted on GitHub: #14, #15",
    });
    // GitHub also answers 404 for a private repository the agent lost access to: that is a failure read again.
    github(h, { notifications: [notification(16)] });
    await expect(pollRound(h)).rejects.toThrow("#16: Error: gh: Not Found (HTTP 404)");
    expect(h.store.get("github-retry")).toEqual({ 16: expect.objectContaining({ pr: false }) });
    h.store.close();
  });
  it("skips and counts a notification or comment it cannot read, and names the count in the health", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    const comment = {
      id: 3,
      body: "@agent-bot please fix",
      user: { login: "alice", type: "User" },
      html_url: "https://github.com/acme/widgets/issues/12#issuecomment-3",
      created_at: "2026-09-09T00:00:00Z",
      updated_at: "2026-09-09T00:00:00Z",
    };
    github(h, {
      notifications: [notification(12), { id: "n-odd", subject: {} }],
      "issues/12": issue(12, { created_at: "2026-08-01T00:00:00Z" }),
      "issues/12/comments": [comment, { body: "no id" }],
    });
    await pollRound(h);
    expect(h.receive.mock.calls.map(([trigger]) => trigger.text)).toEqual(["@agent-bot please fix"]);
    expect(h.health.github).toMatchObject({
      state: "ready",
      detail: "1 notifications; next poll ≥ 60s; 2 unreadable items skipped",
    });
    h.store.close();
  });
  it("reads every page of the notifications when GitHub says there are more, and waits as long as GitHub asks", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    const calls: string[][] = [];
    vi.spyOn(h.commands, "run").mockImplementation(async (_program, args) => {
      calls.push(args);
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, "").split("?")[0]!;
      if (path === "notifications" && args.includes("--include")) {
        return 'HTTP/2.0 200 OK\r\nLink: <https://api.github.com/notifications?page=2>; rel="next"\r\nX-Poll-Interval: 120\r\n\r\n[]';
      }
      if (path === "notifications") return JSON.stringify([[notification(12)], [notification(13)]]);
      if (/^issues\/\d+$/.test(path))
        return JSON.stringify(issue(Number(path.split("/")[1]), { created_at: "2026-08-01T00:00:00Z" }));
      return JSON.stringify(args.includes("--slurp") ? [[]] : []);
    });
    expect(await pollRound(h)).toBe(120);
    const notifications = calls.filter(args => args[1]!.includes("/notifications"));
    expect(notifications.map(args => args.includes("--paginate"))).toEqual([false, true]);
    const paths = calls.map(args => args[1]!.split("?")[0]);
    expect(paths).toEqual(expect.arrayContaining(["repos/acme/widgets/issues/12", "repos/acme/widgets/issues/13"]));
    expect(h.health.github).toMatchObject({ state: "ready", detail: "2 notifications; next poll ≥ 120s" });
    h.store.close();
  });
  it("drops a notified Issue whose reads fail for a day, so the Source leaves the error, and keeps its read position", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    h.store.threads.save({
      key: "github:16",
      ref: { source: "github", id: "16" },
      createdAt: "",
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: {},
    });
    h.store.set("github-cursor:16", "2026-09-01T00:00:00.000Z");
    github(h, { notifications: [notification(16)] });
    await expect(pollRound(h)).rejects.toThrow("#16: Error: gh: Not Found (HTTP 404)");
    const first = h.store.get<Record<string, { failedAt: string; attempts: number }>>("github-retry")![16]!;
    expect(first).toMatchObject({ attempts: 1, failedAt: expect.any(String) });
    // However many reads failed, a day of failures has not passed: the read is retried, and the round still fails.
    h.store.set("github-retry", { 16: { ...first, attempts: 99, nextAt: 0 } });
    github(h, { notifications: [] });
    await expect(pollRound(h)).rejects.toThrow("#16");
    // A day after the first failed read, it is dropped: its Thread keeps the error, the health names it, and the round does not
    // fail. Its read position stays, so a later read takes in what the failed reads missed.
    h.store.set("github-retry", { 16: { ...first, failedAt: new Date(Date.now() - 25 * 3600_000).toISOString() } });
    await pollRound(h);
    expect(h.store.get("github-retry")).toEqual({});
    expect(h.store.get("github-cursor:16")).toBe("2026-09-01T00:00:00.000Z");
    expect(h.store.threads.get("github:16")?.meta.pollError).toContain("Not Found");
    expect(h.health.github).toMatchObject({
      state: "ready",
      detail: "0 notifications; next poll ≥ 60s; dropped after their reads kept failing: #16",
    });
    h.store.close();
  });
  it("polls the PRs of open tickets and subscribed Threads although the notifications fail, and then fails the round", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    h.store.threads.save({
      key: "github:7",
      ref: { source: "github", id: "7" },
      createdAt: "2026-09-01T00:00:00Z",
      lastAt: new Date().toISOString(),
      subscriptions: ["t"],
      correlated: [],
      pending: [],
      meta: { number: 7, isPr: false, title: "Login fails" },
    });
    github(h, {
      notifications: refused(503, "Service Unavailable"),
      "issues/7/comments": [
        {
          id: 3,
          body: "still broken",
          user: { login: "b", type: "User" },
          created_at: "2026-09-02T00:00:00Z",
          updated_at: "2026-09-02T00:00:00Z",
        },
      ],
    });
    await expect(pollRound(h)).rejects.toThrow("HTTP 503");
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ text: "still broken" }));
    expect(h.store.get("github-since")).toBe("2026-09-08T00:00:00.000Z");
    h.store.close();
  });
  it("takes in the description of a notified PR someone opened since the cursor, as a new PR's stream does", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    const pr = { ...openPull(9), body: "@agent-bot please review", created_at: "2026-09-09T00:00:00Z" };
    github(h, { notifications: [notification(9, "pulls")], "pulls/9": pr });
    await pollRound(h);
    const opened = h.receive.mock.calls.map(([trigger]) => trigger).filter(trigger => trigger.meta.kind === "pull");
    const id = issueTrigger({ ...pr, id: 9 } as GithubIssue, "agent-bot").id;
    expect(opened).toEqual([
      expect.objectContaining({
        id,
        addressed: "mention",
        actor: { source: "github", id: "carol" },
        meta: expect.objectContaining({ number: 9, isPr: true, prAuthor: "carol" }),
      }),
    ]);
    // The agent's own PR, and one opened before the cursor, bring no description.
    h.receive.mockClear();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    github(h, { notifications: [notification(9, "pulls")], "pulls/9": { ...pr, user: { login: "agent-bot" } } });
    await pollRound(h);
    h.store.set("github-since", "2026-09-10T00:00:00.000Z");
    github(h, { notifications: [{ ...notification(9, "pulls"), updated_at: "2026-09-11T00:00:00Z" }], "pulls/9": pr });
    await pollRound(h);
    expect(h.receive.mock.calls.filter(([trigger]) => trigger.meta.kind === "pull")).toEqual([]);
    h.store.close();
  });
  it("reads a subscribed default-branch CI Thread as no Issue, and keeps no poll error on it", async () => {
    const h = host();
    h.store.tickets.save(openTicket("ticket"));
    subscribed(h, { source: "github", id: "ci:main" });
    h.store.threads.save({ ...h.store.threads.get("github:ci:main")!, lastAt: new Date().toISOString() });
    const reads = github(h, {});
    await pollGithubThreads(h);
    expect(reads).toEqual([]);
    expect(h.store.threads.get("github:ci:main")!.meta).not.toHaveProperty("pollError");
    h.store.close();
  });
});
