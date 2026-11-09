import type { SetupProblem } from "../infra/setup.mts";
import { describe, it } from "node:test";
import { expect } from "expect";
import { vi } from "../test-support.mts";
import { testChatKind as feishuKind } from "../fixtures/chat-kind.mts";
import { issueTrigger } from "./github-trigger.mts";
import { watchGithub, githubKind, pollFailure, pollRound } from "./github.mts";
import { cursorAt, POLL_HORIZON_MS } from "./poll.mts";
import { commandError } from "../infra/commands.mts";
import { issue, host, openTicket, execution, refused } from "./github-poll.fixtures.mts";

describe("source context", () => {
  it("gives each kind the setup problem whose place it is", () => {
    const feishu: SetupProblem = { place: "feishu", code: "feishuNoBot", values: {}, detail: "No bot" };
    const github: SetupProblem = { place: "github", code: "agentCliUnset", values: {}, detail: "No CLI" };
    const h = host({ feishuProblem: feishu, setupProblem: github });
    expect(h.context(feishuKind).problem).toBe(feishu);
    expect(h.context(githubKind).problem).toBe(github);
    expect(h.context({ kind: "probe", health: [] }).problem).toBeUndefined();
    h.store.close();
  });
  it("lets a kind report only its own health entries", () => {
    const h = host();
    const github = h.context(githubKind);
    github.report("github", { state: "ready", detail: "ok" });
    expect(h.health.github).toEqual({ state: "ready", detail: "ok" });
    expect(() => github.report("feishu", { state: "error", detail: "x" })).toThrow("no health entry feishu");
    h.store.close();
  });
  it("patches a Thread's meta as it is now, so a change another writer made meanwhile stays", () => {
    const h = host();
    h.store.threads.save({
      key: "github:7",
      ref: { source: "github", id: "7" },
      createdAt: "",
      subscriptions: [],
      correlated: [],
      pending: [],
      meta: { title: "old", pollError: "boom" },
    });
    const snapshot = h.store.threads.get("github:7")!;
    h.store.threads.save({ ...snapshot, subscriptions: ["t"], meta: { ...snapshot.meta, label: "#7 old" } });
    h.threads.patch("github:7", { title: "new", pollError: undefined });
    expect(h.store.threads.get("github:7")).toMatchObject({
      subscriptions: ["t"],
      meta: { title: "new", label: "#7 old" },
    });
    expect(h.store.threads.get("github:7")!.meta).not.toHaveProperty("pollError");
    // A Thread that does not exist is not created.
    h.threads.patch("github:8", { title: "x" });
    expect(h.store.threads.get("github:8")).toBeUndefined();
    h.store.close();
  });
  it("reads the configuration of an instance that is on, removes a record set to undefined, and merges ticket meta", () => {
    const h = host();
    expect(h.config("feishu")).toMatchObject({ directMessages: true });
    h.store.saveSettings({
      ...h.store.settings(),
      sources: { ...h.store.settings().sources, feishu: { enabled: false, config: {} } },
    });
    expect(h.config("feishu")).toBeUndefined();
    h.state.set("github-retry", { 1: {} });
    h.state.set("github-retry", undefined);
    expect(h.store.keys("github-retry")).toEqual([]);
    h.store.tickets.save({ ...openTicket("t1"), execution: execution("one") });
    h.tickets.bindThread("t1", { source: "github", id: "4" }, true);
    // The ticket follows the Thread; its other fields stay as they were.
    expect(h.store.tickets.get("t1")).toMatchObject({
      follows: [{ thread: "github:4", own: true }],
      execution: execution("one"),
      origin: { triggerId: "source-t1" },
    });
    h.store.close();
  });
});

it("reports GitHub as failing only after the configured number of consecutive failed polls", () => {
  const eof = new Error('Get "https://api.github.com/x": EOF');
  expect(pollFailure(1, 3, eof)).toBeUndefined();
  expect(pollFailure(2, 3, eof)).toBeUndefined();
  expect(pollFailure(3, 3, eof)).toEqual({
    state: "error",
    detail: '3 consecutive failed polls; last: Error: Get "https://api.github.com/x": EOF',
    code: "pollFailures",
    values: { count: "3", error: 'Error: Get "https://api.github.com/x": EOF' },
  });
  expect(githubKind.schema.parse({})).toEqual({
    repository: "",
    cli: "",
    pollSeconds: 60,
    failuresBeforeError: 3,
    observeIssues: false,
    observePulls: false,
    observeComments: false,
    observeCi: false,
  });
});

describe("observing the GitHub repository", () => {
  /** Hour `hour` of the day before yesterday, well within the polling horizon. */
  const at = (hour: number) =>
    new Date(Math.floor(Date.now() / 86_400_000 - 2) * 86_400_000 + hour * 3_600_000).toISOString();
  const observe = (h: ReturnType<typeof host>, config: Record<string, boolean>) =>
    h.store.saveSettings({
      ...h.store.settings(),
      sources: { ...h.store.settings().sources, github: { enabled: true, config } },
    });
  /** GitHub as the repository's lists and its default branch answer; a request with the ETag of an unchanged list answers 304. */
  function repository(
    h: ReturnType<typeof host>,
    answers: {
      issues?: unknown[];
      comments?: unknown[];
      reviewComments?: unknown[];
      branch?: { sha: string; checks: unknown[] };
    },
  ) {
    const calls: string[][] = [];
    vi.spyOn(h.commands, "run").mockImplementation(async (_program, args) => {
      calls.push(args);
      const bare = args[1]!.replace(/^repos\/acme\/widgets\/?/, "").split("?")[0]!;
      const listed = (list: unknown[] | undefined) =>
        `HTTP/2.0 200 OK\r\nETag: "same"\r\n\r\n${JSON.stringify(list ?? [])}`;
      if (bare === "notifications") return "HTTP/2.0 200 OK\r\n\r\n[]";
      if (args.includes('If-None-Match: "same"')) throw commandError({ stderr: "gh: HTTP 304", code: 1 });
      if (bare === "issues") return listed(answers.issues);
      if (bare === "issues/comments") return listed(answers.comments);
      if (bare === "pulls/comments") return listed(answers.reviewComments);
      if (bare === "") return JSON.stringify({ default_branch: "main" });
      if (bare === "commits/main") return JSON.stringify({ sha: answers.branch!.sha });
      if (bare.endsWith("/check-runs")) return JSON.stringify([{ check_runs: answers.branch!.checks }]);
      return JSON.stringify(args.includes("--slurp") ? [[]] : []);
    });
    return calls;
  }
  it("consumes tied-timestamp comment pages and retains the cursor when a later page fails", async () => {
    const h = host();
    observe(h, { observeComments: true });
    const initial = { since: at(0), started: { comments: at(0) } };
    h.store.set("github-stream:comments", initial);
    const comments = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      body: `Comment ${index + 1}`,
      user: { login: "alice", type: "User" },
      created_at: at(1),
      updated_at: at(1),
      issue_url: "https://api.github.com/repos/acme/widgets/issues/7",
      html_url: `https://github.com/acme/widgets/issues/7#issuecomment-${index + 1}`,
    }));
    let failLater = true;
    vi.spyOn(h.commands, "run").mockImplementation(async (_program, args) => {
      if (!args[1]!.startsWith("repos/acme/widgets/issues/comments?")) return "HTTP/2.0 200 OK\r\n\r\n[]";
      if (args.includes("--paginate")) {
        if (failLater) throw refused(502, "Page two failed");
        return JSON.stringify([comments.slice(0, 100), comments.slice(100)]);
      }
      return `HTTP/2.0 200 OK\r\nETag: "page-one"\r\nLink: <https://api.github.com/repos/acme/widgets/issues/comments?page=2>; rel="next"\r\n\r\n${JSON.stringify(comments.slice(0, 100))}`;
    });
    await expect(pollRound(h)).rejects.toThrow("Page two failed");
    expect(h.store.get("github-stream:comments")).toEqual(initial);
    failLater = false;
    await pollRound(h);
    expect(new Set(h.receive.mock.calls.map(([trigger]) => trigger.id)).size).toBe(101);
    expect(h.store.get("github-stream:comments")).toEqual({ since: cursorAt(at(1)), started: initial.started });
    await pollRound(h);
    expect(new Set(h.receive.mock.calls.map(([trigger]) => trigger.id)).size).toBe(101);
  });
  it("takes in the new Issues and PRs from when it started observing them, and asks again with the ETag while nothing is newer", async () => {
    const h = host();
    observe(h, { observeIssues: true, observePulls: true });
    h.store.set("github-since", at(-24));
    h.store.set("github-stream:issues", { since: at(0), started: { issues: at(0), pulls: at(0) } });
    const calls = repository(h, {
      issues: [
        issue(3, { created_at: at(-24), updated_at: at(1) }),
        issue(4, { created_at: at(2), updated_at: at(2) }),
        { ...issue(5, { created_at: at(3), updated_at: at(3) }), pull_request: { url: "x" } },
        issue(6, { created_at: at(4), updated_at: at(4), user: { login: "agent-bot", type: "User" } }),
      ],
    });
    await pollRound(h);
    // #3 was opened before the Source observed Issues, and #6 is the agent's own.
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.kind, trigger.id])).toEqual([
      [4, "issue", issueTrigger(issue(4), "agent-bot").id],
      [5, "pull", issueTrigger(issue(5), "agent-bot").id],
    ]);
    const started = { issues: at(0), pulls: at(0) };
    expect(h.store.get("github-stream:issues")).toEqual({ since: cursorAt(at(4)), started });
    const list = () => calls.filter(args => args[1]!.startsWith("repos/acme/widgets/issues?"));
    expect(list()[0]![1]).toContain(`since=${encodeURIComponent(at(0))}`);
    // The next round repeats the request at the newest Issue, whose ETag the round after sends, which GitHub answers 304 for.
    await pollRound(h);
    expect(h.store.get("github-stream:issues")).toEqual({ since: cursorAt(at(4)), started, etag: '"same"' });
    h.receive.mockClear();
    await pollRound(h);
    expect(list().at(-1)).toEqual(expect.arrayContaining(["-H", 'If-None-Match: "same"']));
    expect(h.receive).not.toHaveBeenCalled();
    // Switched off, the stream forgets where it was, so it starts afresh once switched on again.
    observe(h, {});
    await pollRound(h);
    expect(h.store.get("github-stream:issues")).toBeUndefined();
    h.store.close();
  });
  it("takes in the repository's conversation and review comments, on the Issue or PR each is on", async () => {
    const h = host();
    observe(h, { observeComments: true });
    h.store.set("github-since", at(-24));
    for (const stream of ["comments", "review-comments"]) {
      h.store.set(`github-stream:${stream}`, { since: at(0), started: { comments: at(0) } });
    }
    const comment = (id: number, fields: Record<string, unknown>) => ({
      id,
      body: `comment ${id}`,
      user: { login: "carol", type: "User" },
      created_at: at(1),
      updated_at: at(1),
      ...fields,
    });
    repository(h, {
      comments: [
        comment(1, {
          issue_url: "https://api.github.com/repos/acme/widgets/issues/7",
          html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1",
        }),
        comment(2, {
          issue_url: "https://api.github.com/repos/acme/widgets/issues/9",
          html_url: "https://github.com/acme/widgets/pull/9#issuecomment-2",
          user: { login: "dependabot[bot]", type: "Bot" },
        }),
      ],
      reviewComments: [
        comment(3, {
          pull_request_url: "https://api.github.com/repos/acme/widgets/pulls/9",
          path: "src/a.ts",
          line: 4,
          html_url: "https://github.com/acme/widgets/pull/9#discussion_r3",
        }),
      ],
    });
    await pollRound(h);
    expect(
      h.receive.mock.calls.map(([trigger]) => [
        trigger.meta.number,
        trigger.meta.isPr,
        trigger.meta.kind,
        trigger.human,
      ]),
    ).toEqual([
      [7, false, "conversation", true],
      [9, true, "conversation", false],
      [9, true, "inline", true],
    ]);
    h.store.close();
  });
  it("fails the round for a stream whose read fails, keeps its cursor, and still reads the other streams", async () => {
    const h = host();
    observe(h, { observeIssues: true, observeComments: true });
    h.store.set("github-since", at(-24));
    const kind = (stream: string) => (stream === "issues" ? "issues" : "comments");
    for (const stream of ["issues", "comments", "review-comments"]) {
      h.store.set(`github-stream:${stream}`, { since: at(0), started: { [kind(stream)]: at(0) } });
    }
    const comment = {
      id: 1,
      body: "looks off",
      user: { login: "carol", type: "User" },
      created_at: at(1),
      updated_at: at(1),
      issue_url: "https://api.github.com/repos/acme/widgets/issues/7",
      html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1",
    };
    repository(h, { comments: [comment] });
    const answer = vi.mocked(h.commands.run).getMockImplementation();
    if (!answer) throw new Error("Expected the fake GitHub boundary");
    vi.mocked(h.commands.run).mockImplementation(async (program, args) => {
      if (args[1]!.startsWith("repos/acme/widgets/issues?")) throw refused(502, "Bad Gateway");
      return answer(program, args);
    });
    await expect(pollRound(h)).rejects.toThrow(/issues: .*502/);
    expect(h.store.get("github-stream:issues")).toEqual({ since: at(0), started: { issues: at(0) } });
    expect(h.receive).toHaveBeenCalledWith(expect.objectContaining({ text: "looks off" }));
    expect(h.store.get("github-stream:comments")).toEqual({ since: cursorAt(at(1)), started: { comments: at(0) } });
    h.store.close();
  });
  it("reads a stream whose cursor is older than the polling horizon from the horizon, without the ETag of the older request", async () => {
    const h = host();
    observe(h, { observeIssues: true });
    h.store.set("github-since", at(-24));
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    h.store.set("github-stream:issues", { since: old, started: { issues: old }, etag: '"same"' });
    const calls = repository(h, {});
    await pollRound(h);
    const list = calls.find(args => args[1]!.startsWith("repos/acme/widgets/issues?"))!;
    expect(list).not.toContain("-H");
    const since = Date.parse(decodeURIComponent(/since=([^&]+)/.exec(list[1]!)![1]!));
    // The horizon, on the hour.
    expect(Date.now() - POLL_HORIZON_MS - since).toBeGreaterThanOrEqual(0);
    expect(Date.now() - POLL_HORIZON_MS - since).toBeLessThan(3_600_000);
    h.store.close();
  });
  it("starts the default branch's CI afresh when the default branch is renamed, without a Trigger", async () => {
    const h = host();
    observe(h, { observeCi: true });
    h.store.set("github-since", at(-24));
    h.store.set("github-branch-ci", { branch: "master", failures: [], revision: 2 });
    const answers = {
      branch: { sha: "ddd4444", checks: [{ name: "lint", status: "completed", conclusion: "failure" }] },
    };
    repository(h, answers);
    await pollRound(h);
    expect(h.receive).not.toHaveBeenCalled();
    expect(h.store.get("github-branch-ci")).toEqual({ branch: "main", failures: ["lint"], revision: 2 });
    h.store.close();
  });
  it("takes in new PRs only from when their switch turned on, apart from when new Issues were", async () => {
    const h = host();
    observe(h, { observeIssues: true, observePulls: true });
    h.store.set("github-since", at(-24));
    // The stream took in Issues from hour 0; PRs were switched on only now.
    h.store.set("github-stream:issues", { since: at(0), started: { issues: at(0) } });
    repository(h, {
      issues: [
        { ...issue(5, { created_at: at(2), updated_at: at(2) }), pull_request: { url: "x" } },
        issue(6, { created_at: at(3), updated_at: at(3) }),
      ],
    });
    await pollRound(h);
    expect(h.receive.mock.calls.map(([trigger]) => [trigger.meta.number, trigger.meta.kind])).toEqual([[6, "issue"]]);
    expect(h.store.get<{ started: Record<string, string> }>("github-stream:issues")!.started).toEqual({
      issues: at(0),
      pulls: expect.any(String),
    });
    // Switched off, a kind forgets its start.
    observe(h, { observePulls: true });
    await pollRound(h);
    expect(Object.keys(h.store.get<{ started: Record<string, string> }>("github-stream:issues")!.started)).toEqual([
      "pulls",
    ]);
    h.store.close();
  });
  it("keeps a stream's cursor five seconds before its newest item, and a stale cursor on the hour, so the ETag is sent again", async () => {
    const h = host();
    observe(h, { observeIssues: true });
    h.store.set("github-since", at(-24));
    h.store.set("github-stream:issues", { since: at(0), started: { issues: at(0) } });
    repository(h, { issues: [issue(6, { created_at: at(3), updated_at: at(3) })] });
    await pollRound(h);
    expect(h.store.get<{ since: string }>("github-stream:issues")!.since).toBe(
      new Date(Date.parse(at(3)) - 5000).toISOString(),
    );
    // A cursor behind the horizon reads from the horizon on the hour, the same in the next round, which sends the ETag.
    const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
    h.store.set("github-stream:issues", { since: old, started: { issues: old } });
    const calls = repository(h, {});
    await pollRound(h);
    await pollRound(h);
    const lists = calls.filter(args => args[1]!.startsWith("repos/acme/widgets/issues?"));
    const since = (args: string[]) => decodeURIComponent(/since=([^&]+)/.exec(args[1]!)![1]!);
    expect(since(lists[0]!)).toBe(since(lists[1]!));
    expect(Date.parse(since(lists[0]!)) % 3_600_000).toBe(0);
    expect(lists[1]).toEqual(expect.arrayContaining(["-H", 'If-None-Match: "same"']));
    h.store.close();
  });
  it("gives each change of the default branch's CI its own id, also when one commit fails, passes and fails again", async () => {
    const h = host();
    observe(h, { observeCi: true });
    h.store.set("github-since", at(-24));
    const check = (name: string, conclusion: string) => ({ name, status: "completed", conclusion });
    const answers = { branch: { sha: "eee5555", checks: [check("lint", "success")] } };
    repository(h, answers);
    await pollRound(h);
    for (const conclusion of ["failure", "success", "failure"]) {
      answers.branch = { sha: "eee5555", checks: [check("lint", conclusion)] };
      await pollRound(h);
    }
    const ids = h.receive.mock.calls.map(([trigger]) => trigger.id);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    // Switched off and on again, the CI starts from a new first look, and its ids keep counting.
    observe(h, {});
    await pollRound(h);
    observe(h, { observeCi: true });
    await pollRound(h);
    answers.branch = { sha: "eee5555", checks: [check("lint", "success")] };
    await pollRound(h);
    expect(new Set(h.receive.mock.calls.map(([trigger]) => trigger.id)).size).toBe(4);
    h.store.close();
  });
  it("tells of the default branch's CI when its failed checks change and once it passes again, after a first look", async () => {
    const h = host();
    observe(h, { observeCi: true });
    h.store.set("github-since", at(-24));
    const check = (name: string, conclusion: string | null) => ({
      name,
      status: conclusion ? "completed" : "in_progress",
      conclusion,
    });
    const answers = { branch: { sha: "aaa1111", checks: [check("lint", "success"), check("e2e", "success")] } };
    repository(h, answers);
    const texts = () => h.receive.mock.calls.map(([trigger]) => trigger.text.split("\n")[0]);
    await pollRound(h);
    expect(texts()).toEqual([]);
    answers.branch = { sha: "bbb2222", checks: [check("lint", "failure"), check("e2e", null)] };
    await pollRound(h);
    answers.branch = { sha: "bbb2222", checks: [check("lint", "failure"), check("e2e", "success")] };
    await pollRound(h);
    // A rerun that still runs is no recovery yet; the recovery is told once every check passes.
    answers.branch = { sha: "ccc3333", checks: [check("lint", null), check("e2e", null)] };
    await pollRound(h);
    answers.branch = { sha: "ccc3333", checks: [check("lint", "success"), check("e2e", "success")] };
    await pollRound(h);
    expect(texts()).toEqual([
      "CI failed 1/2 on main at bbb2222: lint; 1 still running",
      "CI passed 2/2 on main at ccc3333",
    ]);
    expect(h.receive.mock.calls[0]![0]).toMatchObject({
      human: false,
      actor: { id: "" },
      threads: [{ source: "github", id: "ci:main" }],
      meta: { ci: true, branch: "main", sha: "bbb2222" },
      url: "https://github.com/acme/widgets/commit/bbb2222",
    });
    expect(h.receive.mock.calls[0]![0].text).toContain("Read github/commits/bbb2222/checks for every check.");
    h.store.close();
  });
});

it("backs off failed rounds, honors rate-limit cooldown and resets after recovery", async t => {
  const h = host(),
    controller = new AbortController(),
    waits: number[] = [];
  vi.spyOn(h.commands, "withSignal").mockReturnValue(h.commands);
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  let round = 0;
  vi.spyOn(h.commands, "run").mockImplementation(async () => {
    round++;
    if (round === 1)
      throw commandError({
        code: 1,
        stderr: "gh: Rate limited (HTTP 429)",
        stdout: "HTTP/2.0 429\r\nRetry-After: 600\r\n\r\n{}",
      });
    if (round !== 3) throw refused(503, "Unavailable");
    return "HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n[]";
  });
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => {
    waits.push(ms);
    return schedule(() => {
      if (waits.length === 4) controller.abort();
      callback();
    }, 0);
  });
  try {
    await watchGithub(h, controller.signal);
  } finally {
    controller.abort();
  }
  expect(waits).toEqual([600000, 240000, 60000, 120000]);
});
