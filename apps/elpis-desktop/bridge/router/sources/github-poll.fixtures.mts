import type { GithubIssue } from "./github-trigger.mts";
import { afterEach } from "node:test";
import { vi } from "../test-support.mts";
import { Engine, type Assessor, type Executor, type Ticket, type Trigger } from "../core/index.mts";
import { testChatKind as feishuKind } from "../fixtures/chat-kind.mts";
import { type Pull } from "./github-pull.mts";
import type { SourceHost } from "./host.mts";
import { startGithub, githubKind } from "./github.mts";
import { SourceRegistry } from "./registry.mts";
import { Store } from "../app/store.mts";
import { Commands, commandError } from "../infra/commands.mts";
import { HealthBoard } from "../infra/health.mts";
import { testDeployment } from "../fixtures/deployment.mts";
import { SettingsSchema, settingsPolicy } from "../policy.mts";
import { sourceContext as sourceContextOf, type SourceContextDeps } from "../source-context.mts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const pollStops = new Set<() => Promise<void>>();

export function startTestGithub(host: SourceHost) {
  const stop = startGithub(host);
  pollStops.add(stop);
  return stop;
}

export const directories = new Set<string>(),
  stores = new Set<Store>();

afterEach(async () => {
  await Promise.allSettled([...pollStops].map(stop => stop()));
  pollStops.clear();
});

afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {}
  }
  stores.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

export const MEMBER = "ou_alice";

export function host(overrides: Partial<SourceContextDeps> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sources-"));
  directories.add(directory);
  const store = new Store(join(directory, "db.sqlite"));
  stores.add(store);
  const settings = SettingsSchema.parse({
    policy: {
      sources: {
        feishu: { allowed: [{ id: "ou_alice", name: "Alice" }], syncChat: "oc_team" },
        github: { allowed: [{ id: "alice" }] },
      },
    },
    eval: { mode: "auto" },
    sources: {
      feishu: {
        enabled: true,
        config: {
          chats: [
            { chatId: "oc_team", listen: "mentions" },
            { chatId: "oc_observed", listen: "all" },
          ],
          directMessages: true,
        },
      },
    },
  });
  store.saveSettings(settings);
  const board = new HealthBoard();
  const sources = new SourceRegistry(() => store.settings(), board);
  const deployment = testDeployment();
  sources.register(feishuKind);
  sources.register(githubKind);
  const assessor: Assessor = { request: vi.fn(() => {}) };
  const executor: Executor = { start: vi.fn(() => {}), deliver: vi.fn(() => {}), stop: vi.fn(() => {}) };
  const outbox = { send: () => {}, status: () => undefined, withdraw: () => {} };
  const engine = new Engine({
    repo: store,
    scope: sources,
    policy: () => settingsPolicy(store.settings(), sources),
    assessor,
    executor,
    outbox,
  });
  const commands = new Commands(() => deployment, {}, new AbortController().signal);
  const receive = vi.fn(async (trigger: Trigger) => {
    const result = engine.receive(trigger);
    engine.evaluateDue();
    return result;
  });
  // Record outbound messages in the store without sending them.
  const parts: SourceContextDeps = {
    store,
    engine,
    outbox: {
      send: message => {
        store.receipts.add(message);
      },
    },
    commands,
    sources,
    deployment,
    ready: Promise.resolve(),
    configured: () => true,
    receive,
    ...overrides,
  };
  // The Sources' functions take the context; plugin entries and kind callbacks take the host, which builds each kind's context.
  const value = {
    ...parts,
    context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind),
  };
  const context = sourceContextOf(parts, { kind: "feishu", health: ["github", "feishu", "history"] });
  const health = overrides.sources ? healthOf.get(overrides.sources)!.all : board.all;
  return { ...value, ...context, health, store, engine, commands: parts.commands, receive, executor };
}

export const healthOf = new WeakMap<SourceRegistry, HealthBoard>();

export function emptyRegistry(): SourceRegistry {
  const board = new HealthBoard();
  const sources = new SourceRegistry(() => SettingsSchema.parse({}), board);
  healthOf.set(sources, board);
  return sources;
}

export const subscribed = (
  h: ReturnType<typeof host>,
  ref: { source: string; id: string },
  meta: Record<string, unknown> = {},
) =>
  h.store.threads.save({
    key: `${ref.source}:${ref.id}`,
    ref,
    createdAt: new Date().toISOString(),
    subscriptions: ["ticket"],
    correlated: [],
    pending: [],
    meta,
  });

export const openTicket = (id: string): Ticket => ({
  id,
  title: id,
  decisionId: `d-${id}`,
  mandate: {
    strength: "explicit",
    policyVersion: "",
    basis: { via: "listed" },
    actor: { source: "github", id: "alice" },
    scope: "",
  },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: "",
  updatedAt: "",
  origin: { triggerId: `source-${id}`, triggerIds: [] },
});

export const execution = (name: string) => ({ name, directory: `/w/${name}`, assignment: "" });

export const pulled = (number: number) => ({ follows: [{ thread: `github:${number}`, own: true }] });

export const endedPull = (number: number, at: string, merged = true): Pull => ({
  ...openPull(number),
  state: "closed",
  merged,
  ...(merged ? { merged_at: at } : { closed_at: at }),
});

export const agentsPull = (number: number, ref: string): Pull => ({
  ...openPull(number),
  user: { login: "agent-bot" },
  head: { sha: "abc", ref, repo: { full_name: "acme/widgets" } },
});

export const openPull = (number: number) => ({
  number,
  title: "Fix the margin",
  state: "open",
  html_url: `https://github.com/acme/widgets/pull/${number}`,
  user: { login: "carol" },
  head: { sha: "abc", ref: "fix", repo: { full_name: "acme/widgets" } },
});

export const notification = (number: number, kind: "issues" | "pulls" = "issues") => ({
  id: `n${number}`,
  updated_at: "2026-09-09T00:00:00Z",
  reason: "mention",
  repository: { full_name: "acme/widgets" },
  subject: {
    url: `https://api.github.com/repos/acme/widgets/${kind}/${number}`,
    type: kind === "pulls" ? "PullRequest" : "Issue",
    title: "",
  },
});

export const refused = (status: number, text: string) => commandError({ stderr: `gh: ${text} (HTTP ${status})`, code: 1 });

/** Stubs `gh api` calls against `acme/widgets` and returns the requested paths in order. */
export function github(h: ReturnType<typeof host>, routes: Record<string, unknown>): string[] {
  const reads: string[] = [];
  vi.spyOn(h.commands, "run").mockImplementation(async (_program, args) => {
    reads.push(args[1]!.replace(/^repos\/acme\/widgets\//, ""));
    const path = reads.at(-1)!.split("?")[0]!;
    const list = /\/(comments|reviews|statuses)$/.test(path) ? [] : refused(404, "Not Found");
    const route = routes[path] ?? (path.endsWith("/check-runs") ? { check_runs: [] } : list);
    const value: unknown = typeof route === "function" ? (route as () => unknown)() : route;
    if (value instanceof Error) throw value;
    if (args.includes("--include")) return `HTTP/2.0 200 OK\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify(value)}`;
    return JSON.stringify(args.includes("--slurp") ? [value] : value);
  });
  return reads;
}

export const bare = (reads: string[]) => reads.map(path => path.split("?")[0]);

export const issue = (number: number, fields: Partial<GithubIssue> = {}): GithubIssue => ({
  id: 1000 + number,
  number,
  title: "Login fails",
  body: "details",
  state: "open",
  created_at: "2026-09-09T00:00:00Z",
  html_url: `https://github.com/acme/widgets/issues/${number}`,
  user: { login: "alice", type: "User" },
  ...fields,
});
