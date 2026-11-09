import { describe, it } from "node:test";
import { expect } from "expect";
import { vi } from "../test-support.mts";
import { key, type Trigger } from "../core/index.mts";
import { commentTrigger, githubChannel, type GithubComment, type GithubIssue } from "./github-trigger.mts";
import { claimPull, observePull, pullOf, type Pull } from "./github-pull.mts";
import { pollRound } from "./github.mts";
import { SourceRegistry } from "./registry.mts";
import { Commands } from "../infra/commands.mts";
import { HealthBoard } from "../infra/health.mts";
import { SettingsSchema } from "../policy.mts";
import { type SourceContextDeps } from "../source-context.mts";
import { issue, startTestGithub, host, healthOf, emptyRegistry, subscribed, openTicket, execution, pulled, endedPull, openPull, notification, refused, github, bare } from "./github-poll.fixtures.mts";

describe("github source", () => {
  it("drops an Issue or a ticket's PR that GitHub answers 410 for, and keeps a failed PR read on its Thread", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    h.store.tickets.save({
      ...openTicket("ticket"),
      follows: [
        { thread: "github:7", own: true },
        { thread: "github:8", own: true },
      ],
    });
    subscribed(h, { source: "github", id: "5" }, { number: 5, isPr: false, title: "Gone" });
    h.store.threads.save({ ...h.store.threads.get("github:5")!, lastAt: new Date().toISOString() });
    // The PRs' Threads, which nothing subscribes to, so only the ticket's PR reads reach them.
    for (const number of [7, 8]) {
      h.store.threads.save({
        key: `github:${number}`,
        ref: { source: "github", id: String(number) },
        createdAt: "",
        subscriptions: [],
        correlated: [],
        pending: [],
        meta: {},
      });
    }
    github(h, { notifications: [], "issues/5/comments": refused(410, "Gone"), "pulls/7": refused(410, "Gone") });
    // Every PR read but #8's succeeds or is dropped; #8 fails like a network error.
    vi.mocked(h.commands.run).mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, "").split("?")[0]!;
      if (path === "notifications") return "HTTP/2.0 200 OK\r\n\r\n[]";
      if (path === "issues/5/comments" || path === "pulls/7") throw refused(410, "Gone");
      if (path === "pulls/8") throw refused(502, "Bad Gateway");
      return JSON.stringify(args.includes("--slurp") ? [[]] : []);
    });
    await expect(pollRound(h)).rejects.toThrow(/#8: .*502/);
    expect(h.store.threads.get("github:8")!.meta.pollError).toContain("502");
    expect(h.store.threads.get("github:7")!.meta.pollError).toContain("410");
    vi.mocked(h.commands.run).mockImplementation(async (_program, args) => {
      const path = args[1]!.replace(/^repos\/acme\/widgets\//, "").split("?")[0]!;
      if (path === "notifications") return "HTTP/2.0 200 OK\r\n\r\n[]";
      if (path === "issues/5/comments" || path === "pulls/7" || path === "pulls/8") throw refused(410, "Gone");
      return JSON.stringify(args.includes("--slurp") ? [[]] : []);
    });
    // With every failure a 410, the round succeeds and names what GitHub deleted.
    await pollRound(h);
    expect(h.health.github).toMatchObject({
      state: "ready",
      detail: expect.stringContaining("deleted on GitHub: #5, #7, #8"),
    });
    h.store.close();
  });
  it("waits for setup, pauses while the Source is off, and counts only consecutive failed polls towards an error", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const start = async (
        overrides: Partial<SourceContextDeps>,
        github: { enabled: boolean; config: Record<string, unknown> } = { enabled: true, config: {} },
      ) => {
        const board = new HealthBoard();
        const settings = SettingsSchema.parse({ sources: { github } });
        const sources = new SourceRegistry(() => settings, board);
        healthOf.set(sources, board);
        const value = host({ sources, ...overrides });
        const disposers: (() => unknown)[] = [];
        disposers.push(startTestGithub(value));
        return {
          value,
          stop: async () => {
            for (const dispose of disposers) await dispose();
            value.store.close();
          },
        };
      };
      const pending = await start({ configured: () => false });
      await vi.waitFor(() =>
        expect(pending.value.health.github).toMatchObject({ state: "paused", code: "setupPending" }),
      );
      await pending.stop();
      const off = await start({}, { enabled: false, config: {} });
      await vi.waitFor(() => expect(off.value.health.github).toMatchObject({ state: "paused", code: "sourceOff" }));
      await off.stop();
      // Rounds fail, succeed, fail, fail: only the last two in a row make the error. A round reads through a Commands of its own.
      const outcomes = [false, true, false, false];
      let round = 0;
      const run = vi.spyOn(Commands.prototype, "run").mockImplementation(async () => {
        if (!outcomes[round++]) throw refused(502, "Bad Gateway");
        return "HTTP/2.0 200 OK\r\n\r\n[]";
      });
      const flaky = await start({}, { enabled: true, config: { failuresBeforeError: 2 } });
      // Each round reads its notifications once, then waits a minute for the next.
      const until = async (count: number) => {
        while (round < count) {
          await vi.waitFor(() => expect(round).toBeGreaterThan(0));
          if (round < count) await vi.advanceTimersByTimeAsync(60_000);
        }
      };
      await until(3);
      expect(flaky.value.health.github).toMatchObject({ state: "ready" });
      await until(4);
      await vi.waitFor(() =>
        expect(flaky.value.health.github).toMatchObject({
          state: "error",
          code: "pollFailures",
          values: { count: "2" },
        }),
      );
      await flaky.stop();
      run.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
  it("reports a failure that escapes the polling loop as its health instead of an unhandled rejection", async () => {
    // The fixture's registry already holds the kind; this one starts empty so the plugin can register it.
    const value = host({ sources: emptyRegistry(), ready: Promise.reject(new Error("lock held")) });
    const disposers: (() => unknown)[] = [];
    disposers.push(startTestGithub(value));
    await vi.waitFor(() =>
      expect(value.health.github).toMatchObject({ state: "error", detail: expect.stringContaining("lock held") }),
    );
    for (const dispose of disposers) await dispose();
    value.store.close();
  });
  /** An Issue as GitHub returns it, opened by alice. */
  /** GitHub as `pollRound` reads it after `since`: one notification per Issue, the Issues, and their conversation comments by number. */
  function notify(
    h: ReturnType<typeof host>,
    issues: GithubIssue[],
    comments: Record<number, GithubComment[]> = {},
    since = "2026-09-08T00:00:00.000Z",
  ) {
    h.store.set("github-since", since);
    // A notification is as new as the latest change it reports: the Issue or its newest comment.
    const updated = (item: GithubIssue) =>
      [item.updated_at ?? item.created_at, ...(comments[item.number] ?? []).map(comment => comment.updated_at ?? "")]
        .sort()
        .at(-1)!;
    const notifications = issues.map(item => ({
      id: `n${item.number}`,
      updated_at: updated(item),
      reason: "mention",
      repository: { full_name: "acme/widgets" },
      subject: {
        url: `https://api.github.com/repos/acme/widgets/issues/${item.number}`,
        type: "Issue",
        title: item.title,
      },
    }));
    // An Issue that is a PR also answers as the PR.
    const routes: Record<string, unknown> = {
      notifications,
      ...Object.fromEntries(
        issues.flatMap(item => [
          [`issues/${item.number}`, item],
          [`pulls/${item.number}`, openPull(item.number)],
          [`issues/${item.number}/comments`, comments[item.number] ?? []],
        ]),
      ),
    };
    return { routes, reads: github(h, routes) };
  }
  it("takes in a new Issue from its notification as a Trigger with its body, addressed to the agent when the body mentions it", async () => {
    const h = host();
    // A pull request reported at its Issue address, and an Issue the agent opened itself, add nothing.
    const agents = { user: { login: "agent-bot", type: "User" } };
    notify(h, [
      issue(12, { body: "@agent-bot please fix the login" }),
      issue(13, { pull_request: { url: "x" } }),
      issue(14, agents),
    ]);
    await pollRound(h);
    expect(h.receive).toHaveBeenCalledTimes(1);
    const id = key("github-issue", "12");
    const url = "https://github.com/acme/widgets/issues/12";
    expect(h.receive.mock.calls[0]![0]).toEqual({
      id,
      source: "github",
      threads: [{ source: "github", id: "12" }],
      actor: { source: "github", id: "alice" },
      human: true,
      at: "2026-09-09T00:00:00Z",
      text: "Login fails\n\n@agent-bot please fix the login",
      addressed: "mention",
      channel: githubChannel(12, url),
      url,
      meta: { number: 12, isPr: false, kind: "issue" },
    });
    // An allowed sender's mention is an explicit request on that poll.
    expect(h.engine.candidate(id)?.strength).toBe("explicit");
    expect(h.store.threads.get("github:12")!.meta).toMatchObject({ title: "Login fails", label: "#12 Login fails" });
    h.store.close();
  });
  it("takes in a comment on an earlier Issue from its notification, without the Issue body", async () => {
    const h = host();
    const url = "https://github.com/acme/widgets/issues/12";
    const comment: GithubComment = {
      id: 5,
      body: "@agent-bot can you take this?",
      user: { login: "alice", type: "User" },
      html_url: `${url}#issuecomment-5`,
      created_at: "2026-09-09T00:00:00Z",
      updated_at: "2026-09-09T00:00:00Z",
    };
    const { reads } = notify(h, [issue(12, { created_at: "2026-08-01T00:00:00Z" })], { 12: [comment] });
    await pollRound(h);
    const expected = commentTrigger(comment, { number: 12, isPr: false, url }, "conversation", "agent-bot");
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([expected]);
    // An Issue has only its conversation; the comments are read since the notification cursor.
    const since = encodeURIComponent("2026-09-08T00:00:00.000Z");
    expect(reads.filter(path => path.includes("/comments"))).toEqual([
      `issues/12/comments?per_page=100&since=${since}`,
    ]);
    h.store.close();
  });
  it("keeps one body Trigger for an Issue that a later poll reads again", async () => {
    const h = host();
    // Opened just before the poll, the Issue is still after the cursor the next poll reads from.
    notify(
      h,
      [issue(12, { created_at: new Date(Date.now() - 1000).toISOString() })],
      {},
      new Date(Date.now() - 60_000).toISOString(),
    );
    await pollRound(h);
    await pollRound(h);
    expect(h.receive).toHaveBeenCalledTimes(2);
    expect(h.store.read.threadTriggers("github:12", 10).map(trigger => trigger.id)).toEqual([
      key("github-issue", "12"),
    ]);
    expect(h.store.decisions.byThread("github:12").map(decision => decision.triggerIds)).toEqual([
      [key("github-issue", "12")],
    ]);
    h.store.close();
  });
  it("takes in an Issue without a mention as a Trigger that is not addressed, and a bot's Issue as automated", async () => {
    const h = host();
    notify(h, [
      issue(12, { body: "Login fails on Safari" }),
      issue(15, { user: { login: "dependabot[bot]", type: "Bot" } }),
    ]);
    await pollRound(h);
    const taken = (number: number) =>
      h.receive.mock.calls.map(([trigger]) => trigger).find(trigger => trigger.meta.number === number);
    const [plain, bot] = [taken(12), taken(15)];
    expect(plain).toMatchObject({ id: key("github-issue", "12"), human: true });
    expect(plain).not.toHaveProperty("addressed");
    expect(bot).toMatchObject({ id: key("github-issue", "15"), human: false });
    // The Issue's own read position moves past what this round read.
    expect(Date.parse(h.store.get<string>("github-cursor:12")!)).toBeGreaterThan(
      Date.parse("2026-09-08T00:00:00.000Z"),
    );
    h.store.close();
  });
  it("keeps an Issue body the unclaimed-Issue Source stored before as the one Trigger of that body", async () => {
    const h = host();
    const stored: Trigger = {
      id: key("github-issue", "12"),
      source: "github-issue",
      threads: [{ source: "github", id: "12" }],
      actor: { source: "github", id: "alice" },
      human: true,
      at: "2026-09-09T00:00:00Z",
      text: "Login fails\n\n@agent-bot please fix the login",
      meta: { number: 12, isPr: false, eligibleAt: "" },
    };
    h.store.triggers.save(stored);
    notify(h, [issue(12, { body: "@agent-bot please fix the login" })]);
    await pollRound(h);
    expect(await h.receive.mock.results[0]!.value).toBe("duplicate");
    expect(h.store.read.threadTriggers("github:12", 10)).toEqual([stored]);
    h.store.close();
  });
  it("takes in an Issue body only when the Issue was opened since the cursor, not when an edit or a comment changed it", async () => {
    const h = host();
    // Whoever edits the body, its author would be the actor, so a mention added by an edit is not read.
    const edited = issue(12, {
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-09-09T00:00:00Z",
      body: "Login fails. @agent-bot can you look?",
    });
    notify(h, [edited]);
    await pollRound(h);
    expect(h.receive).not.toHaveBeenCalled();
    h.store.close();
  });
  it("reads a PR that a notification names by its Issue address as the PR", async () => {
    const h = host();
    h.store.set("github-since", "2026-09-08T00:00:00.000Z");
    const review = {
      id: 4,
      state: "APPROVED",
      commit_id: "abc",
      user: { login: "carol", type: "User" },
      submitted_at: "2026-09-09T00:00:00Z",
    };
    const reads = github(h, {
      notifications: [notification(9)],
      "issues/9": { ...issue(9), pull_request: { url: "x" } },
      "pulls/9/reviews": [review],
      "pulls/9": {
        title: "Fix",
        state: "open",
        html_url: "https://github.com/acme/widgets/pull/9",
        user: { login: "carol" },
        head: { sha: "abc", ref: "fix", repo: null },
      },
    });
    await pollRound(h);
    expect(bare(reads)).toEqual([
      "notifications",
      "issues/9",
      "pulls/9",
      "issues/9/comments",
      "pulls/9/comments",
      "pulls/9/reviews",
    ]);
    expect(h.receive.mock.calls.map(([trigger]) => trigger)).toEqual([
      expect.objectContaining({ text: "APPROVED review of commit abc", meta: expect.objectContaining({ isPr: true }) }),
    ]);
    h.store.close();
  });
  it("moves no read position when the Source is turned off during a read", async () => {
    const h = host();
    const comment: GithubComment = {
      id: 5,
      body: "more",
      user: { login: "alice", type: "User" },
      created_at: "2026-09-09T00:00:00Z",
      updated_at: "2026-09-09T00:00:00Z",
    };
    const { routes } = notify(h, [issue(12, { created_at: "2026-08-01T00:00:00Z" })], { 12: [comment] });
    routes["issues/12/comments"] = () => {
      h.store.saveSettings({
        ...h.store.settings(),
        sources: { ...h.store.settings().sources, github: { enabled: false, config: {} } },
      });
      return [comment];
    };
    await pollRound(h);
    expect(h.receive).not.toHaveBeenCalled();
    expect(h.store.get("github-cursor:12")).toBeUndefined();
    expect(h.store.get("github-since")).toBe("2026-09-08T00:00:00.000Z");
    h.store.close();
  });
  it("lets a ticket follow its source PR or the agent's PR from its branch, and refuses others", async () => {
    const h = host();
    const source = commentTrigger(
      {
        id: 1,
        body: "@agent-bot fix",
        user: { login: "alice" },
        html_url: "https://github.com/acme/widgets/pull/30#issuecomment-1",
      },
      { number: 30, isPr: true },
      "conversation",
      "agent-bot",
    );
    h.store.triggers.save(source);
    h.store.tickets.save({
      ...openTicket("t1"),
      execution: execution("fix-1"),
      origin: { triggerId: source.id, triggerIds: [source.id] },
    });
    h.store.tickets.save({ ...openTicket("t2"), execution: execution("other-2"), ...pulled(41) });
    const agents = (number: number, ref: string, repo = "acme/widgets"): Pull => ({
      ...openPull(number),
      user: { login: "agent-bot" },
      head: { sha: "abc", ref, repo: { full_name: repo } },
    });
    expect(claimPull(h, "t1", agents(40, "agent/fix-1", "someone/fork"))).toContain(
      "PR does not belong to this ticket",
    );
    expect(
      claimPull(h, "t1", {
        ...openPull(31),
        head: { sha: "abc", ref: "agent/fix-1", repo: { full_name: "acme/widgets" } },
      }),
    ).toContain("PR does not belong to this ticket");
    expect(claimPull(h, "t1", agents(41, "agent/fix-1"))).toBe("PR already belongs to another active ticket");
    // A PR that is not open is not bound, and that is no refusal.
    expect(claimPull(h, "t1", { ...agents(42, "agent/fix-1"), state: "closed" })).toBeUndefined();
    expect(pullOf(h.store.tickets.get("t1")!)).toBeUndefined();
    expect(claimPull(h, "t1", openPull(30))).toBeUndefined();
    expect(h.store.tickets.get("t1")!.follows).toEqual([{ thread: "github:30", own: false }]);
    expect(claimPull(h, "t1", agents(43, "agent/fix-1"))).toBeUndefined();
    expect(h.store.tickets.get("t1")).toMatchObject({
      follows: [
        { thread: "github:30", own: false },
        { thread: "github:43", own: true },
      ],
      channels: [],
    });
    expect(pullOf(h.store.tickets.get("t1")!)).toBe(43);
    expect(h.store.threads.get("github:43")).toMatchObject({
      subscriptions: ["t1"],
      meta: { isPr: true, prAuthor: "agent-bot" },
    });
    // The PR the ticket started from is not one it opened: when its own PR merges, the ticket ends instead of following it.
    expect(observePull(h, endedPull(43, "2026-09-02T00:00:00Z"))).toBe(true);
    expect(h.store.tickets.get("t1")).toMatchObject({ ended: { outcome: "merged" } });
    expect(claimPull(h, "t1", openPull(30))).toBe("Ticket ended because its PR was closed");
    h.store.close();
  });
});
