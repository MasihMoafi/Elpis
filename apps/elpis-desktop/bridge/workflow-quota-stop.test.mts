// E17 (11 Nov, Masih: "chatpgt limit is reached; but I have credits so luna is still the option. I never permitted opus."):
// two runs asked for gpt-6-luna on ChatGPT, Elpis called the subscription exhausted without looking at its credits and ran
// every agent on claude/opus. An agent now runs where it asked, or stops and says why; it never moves to another
// subscription. The Mother's own fallback inside the Claude subscription stays.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { workflowModelRoutes, MOTHER_ROUTE, MOTHER_FALLBACK } from "./workflow-models.mts";
import { providersSnapshot } from "./provider-projections.mts";
import { required, task, fixture } from "./workflow-coding.fixtures.mts";

const RESETS = Math.floor(Date.now() / 1000) + 3 * 3600;
const MODELS = [{ model: "gpt-6-luna" }, { model: "claude/opus" }];
/** His ChatGPT subscription with its weekly window full, and the given credits; Claude connected with room left. */
const providers = (credits: { hasCredits: boolean; unlimited: boolean } | null, usedPercent = 100) => ({
  openai: {
    auth: { state: "signedIn", method: "ChatGPT" },
    usage: [
      {
        primary: { usedPercent: 20, resetsAt: RESETS - 3600 },
        secondary: { usedPercent, resetsAt: RESETS },
        ...(credits ? { credits: { ...credits, balance: null } } : {}),
      },
    ],
  },
  claude: { state: "connected", usage: [{ primary: { usedPercent: 10, resetsAt: RESETS } }] },
});
const LUNA = { model: "gpt-6-luna", provider: "openai" };
const lunaFixture = (t: Parameters<typeof fixture>[0], routes: ReturnType<typeof workflowModelRoutes>) =>
  fixture(t, {
    env: { luna: { FAKE_ACP_MODELS: "gpt-6-luna,opus" } },
    runner: { modelRoutes: async () => routes },
  });
const texts = (owner: { progress?: { kind: string; text?: string }[] }) =>
  (owner.progress ?? []).filter(entry => entry.kind === "text").map(entry => entry.text);

for (const credits of [
  { hasCredits: true, unlimited: false },
  { hasCredits: false, unlimited: true },
])
  test(`a full plan window with ${credits.hasCredits ? "credits" : "unlimited credits"} runs the model he asked for`, async t => {
    const routes = workflowModelRoutes(MODELS, providers(credits), {});
    assert.equal(required(routes.find(route => route.model === "gpt-6-luna")).exhausted, false, "credits count");
    const f = lunaFixture(t, routes);
    const completed = await f.finished((await f.start([task("luna", LUNA)])).graphId);
    assert.equal(completed.status, "succeeded", completed.error ?? undefined);
    const routing = required(required(completed.tasks[0]).routing);
    assert.deepEqual(
      routing.attempts.map(attempt => [attempt.model, attempt.provider, attempt.status]),
      [["gpt-6-luna", "openai", "succeeded"]],
      "nothing is skipped",
    );
    assert.deepEqual(routing.actual, LUNA);
  });

test("the engine's credits reach the workflow routes; their balance does not leave the bridge", () => {
  const window = { usedPercent: 100, windowDurationMins: 10080, resetsAt: RESETS };
  const snapshot = (credits: object) =>
    providersSnapshot({
      account: { account: { type: "chatgpt", email: "person@example.com", planType: "pro" } },
      limits: { rateLimitsByLimitId: { codex: { limitId: "codex", primary: window, secondary: null, credits } } },
      config: { model_providers: {} },
      models: [],
    });
  const withCredits = snapshot({ hasCredits: true, unlimited: false, balance: "PRIVATE BALANCE 42" });
  assert.doesNotMatch(JSON.stringify(withCredits), /PRIVATE BALANCE/);
  const luna = (providers: object) => required(workflowModelRoutes([{ model: "gpt-6-luna" }], providers, {})[0]);
  assert.equal(luna(withCredits).exhausted, false);
  assert.equal(luna(snapshot({ hasCredits: false, unlimited: false, balance: null })).exhausted, true);
});

test("a full plan window without credits stops the agent with the reason; no other subscription is tried", async t => {
  const routes = workflowModelRoutes(MODELS, providers({ hasCredits: false, unlimited: false }), {});
  const f = lunaFixture(t, routes);
  const completed = await f.finished((await f.start([task("luna", LUNA)])).graphId);
  const node = required(completed.tasks[0]);
  const routing = required(node.routing);
  const until = new Date(RESETS * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const line =
    `gpt-6-luna on ChatGPT did not run because the ChatGPT usage limit is reached until ${until}; ` +
    "wait for the reset, or choose another model for this agent and resume.";
  assert.equal(completed.status, "failed");
  assert.deepEqual(
    routing.attempts.map(attempt => [attempt.provider, attempt.status]),
    [["openai", "skipped"]],
    "only the requested subscription appears",
  );
  assert.notEqual(routing.actual?.provider, "claude", "the route never moves to Claude");
  assert.equal(f.log("luna").length, 0, "no agent was started on any subscription");
  assert.equal(node.failureReason, line);
  assert.equal(completed.error, line, "the run's record says the same");
  assert.deepEqual(texts(node), [line], "the agent's chat shows that one line");
  assert.equal(f.log("Mother agent").length, 0, "a quota stop does not ask the Mother");
});

test("a quota error during the run stops the agent there; completed work and worktrees are kept", async t => {
  const f = fixture(t, {
    runner: {
      modelRoutes: async () => [
        { model: "claude/opus", provider: "claude" },
        { model: "m-fast", provider: "openai" },
      ],
    },
    nodeSpec: (node, spec) =>
      node.provider === "claude"
        ? {
            ...spec,
            env: {
              ...spec.env,
              FAKE_ACP_WRITE: JSON.stringify({ file: "src/quota-partial", text: "partial work" }),
              FAKE_ACP_PROMPT_ERROR_AFTER_WRITE: "Claude (ACP) error: You have hit your weekly limit.",
              FAKE_ACP_ERROR_KIND: "provider_error",
            },
          }
        : spec,
  });
  const started = await f.start(
    [
      task("done", { writeScopes: ["src"], model: "m-fast", provider: "openai" }),
      task("limited", { writeScopes: ["src"], model: "claude/opus", provider: "claude" }),
    ],
    { isolation: "worktree" },
  );
  const completed = await f.finished(started.graphId);
  const done = required(completed.tasks.find(node => node.id === "done"));
  const limited = required(completed.tasks.find(node => node.id === "limited"));
  const routing = required(limited.routing);
  const line =
    "claude/opus on Claude stopped because the Claude usage limit was reached during its work; wait for the reset, or choose another model for this agent and resume.";
  assert.equal(completed.status, "failed");
  assert.deepEqual(
    routing.attempts.map(attempt => [attempt.provider, attempt.status]),
    [["claude", "failed"]],
    "no attempt on another subscription",
  );
  assert.match(required(required(routing.attempts[0]).reason), /hit your weekly limit/, "the provider's words are kept");
  assert.deepEqual(routing.actual, { model: "claude/opus", provider: "claude" });
  assert.equal(f.log("limited").filter(row => row.method === "session/prompt").length, 1);
  assert.equal(limited.failureReason, line);
  assert.equal(completed.error, line);
  assert.equal(texts(limited).at(-1), line, "the agent's chat ends with that one line");
  assert.equal(done.status, "succeeded", "the finished agent's work is kept");
  assert.ok(done.result);
  const kept = required(limited.worktree);
  assert.equal(
    fs.readFileSync(path.join(kept.path, "src/quota-partial"), "utf8"),
    "partial work",
    "the stopped agent's partial work stays in its worktree",
  );
  assert.ok(required(completed.worktrees).every(place => fs.existsSync(place.path)), "every worktree is kept");
  assert.equal(f.log("Mother agent").length, 0, "a quota stop does not ask the Mother");
});

test("below 100% nothing changes: the requested model runs", async t => {
  const routes = workflowModelRoutes(MODELS, providers(null, 99), {});
  assert.equal(required(routes[0]).exhausted, false);
  const f = lunaFixture(t, routes);
  const completed = await f.finished((await f.start([task("luna", LUNA)])).graphId);
  assert.equal(completed.status, "succeeded", completed.error ?? undefined);
  assert.deepEqual(
    required(required(completed.tasks[0]).routing).attempts.map(attempt => [attempt.provider, attempt.status]),
    [["openai", "succeeded"]],
  );
});

test("the Mother still falls back from Opus to Sonnet inside the Claude subscription, and never leaves it", async t => {
  const f = fixture(t, {
    env: { bad: { FAKE_ACP_PROMPT_ERROR: "The build tool broke", FAKE_ACP_ERROR_KIND: "provider_error" } },
    runner: {
      modelRoutes: async () => [
        { model: "claude/opus", provider: "claude" },
        { model: "claude/sonnet", provider: "claude" },
        { model: "m-fast", provider: "openai" },
      ],
      modelDefaults: async () => ({ child: null, mother: MOTHER_ROUTE, motherFallback: MOTHER_FALLBACK }),
    },
    nodeSpec: (node, spec) =>
      node.name === "Mother agent"
        ? {
            ...spec,
            env: {
              ...spec.env,
              FAKE_ACP_MODELS: "opus,sonnet,m-fast",
              ...(node.model === "claude/opus"
                ? { FAKE_ACP_PROMPT_ERROR: "You have hit your weekly limit.", FAKE_ACP_ERROR_KIND: "usage_limit_reached" }
                : { FAKE_ACP_ANSWER: JSON.stringify({ action: "stop", reason: "The step crashed; he decides." }) }),
            },
          }
        : spec,
  });
  const completed = await f.finished((await f.start([task("bad")])).graphId);
  assert.equal(completed.status, "failed");
  const mother = required(completed.mother);
  assert.deepEqual(
    required(mother.routing).attempts.map(attempt => [attempt.model, attempt.provider, attempt.status]),
    [
      ["claude/opus", "claude", "failed"],
      ["claude/sonnet", "claude", "succeeded"],
    ],
    JSON.stringify(required(mother.routing).attempts),
  );
  assert.equal(mother.decisions.at(-1)?.decision, "stop", "the Sonnet fallback gave her decision");
});
