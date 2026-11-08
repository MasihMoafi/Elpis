import { describe, it } from "node:test";
import { expect } from "expect";
import { SettingsSchema, policyEffects, settingsPolicy } from "./policy.mts";
import { githubKind } from "./sources/github.mts";
import type { Ticket, Trigger } from "./core/index.mts";
import { CHAT, OBSERVED, base, setup, thread, unaddressed, ticket } from "./policy.fixtures.mts";

describe("policy effects", () => {
  const scope = () => ({ scope: () => ({ listened: true as const, observed: true }) });
  const base = SettingsSchema.parse({
    policy: {
      rules: [
        { id: "copy", name: "Copy", enabled: true, instruction: "Fix typos." },
        { id: "visual", name: "Visual", enabled: true, instruction: "Fix colors." },
      ],
      sources: { feishu: { allowed: [{ id: "ou_alice" }] } },
    },
  });
  const ticket = (id: string, mandate: Pick<Ticket["mandate"], "strength" | "actor" | "basis">): Ticket => ({
    id,
    title: id,
    decisionId: "",
    mandate: { scope: "", policyVersion: "", ...mandate },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: "",
    updatedAt: "",
    origin: { triggerId: "", triggerIds: [] },
  });
  const inferred = ticket("t1", {
    strength: "inferred",
    actor: { source: "feishu", id: "ou_guest" },
    basis: { via: "listed", rules: ["copy"] },
  });
  const explicit = ticket("t2", {
    strength: "explicit",
    actor: { source: "feishu", id: "ou_alice" },
    basis: { via: "listed", source: "feishu" },
  });
  it("tells a ticket how a change bears on it, and leaves the others alone", () => {
    const rules = (copy: object, visual: object = {}) => ({
      ...base,
      policy: {
        ...base.policy,
        rules: [
          { ...base.policy.rules[0]!, ...copy },
          { ...base.policy.rules[1]!, ...visual },
        ],
      },
    });
    // A rule the ticket was not accepted under changes nothing for it.
    expect(policyEffects([inferred, explicit], base, rules({}, { enabled: false }), scope).size).toBe(0);
    expect(policyEffects([inferred], base, rules({ instruction: "Fix typos only." }), scope).get("t1")).toEqual({
      rules: [{ id: "copy", name: "Copy", change: "changed", instruction: "Fix typos only." }],
    });
    expect(policyEffects([inferred], base, rules({ enabled: false }), scope).get("t1")).toEqual({
      rules: [{ id: "copy", name: "Copy", change: "disabled" }],
    });
    // Another sender on the list, as a member sync adds, bears on no ticket; taking the requester off it does.
    const allowed = (list: { id: string }[]) => ({
      ...base,
      policy: {
        ...base.policy,
        sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, allowed: list } },
      },
    });
    expect(policyEffects([inferred, explicit], base, allowed([{ id: "ou_alice" }, { id: "ou_bob" }]), scope).size).toBe(
      0,
    );
    expect(policyEffects([explicit], base, allowed([]), scope).get("t2")).toEqual({
      requesterAllowed: false,
      requester: { source: "feishu", id: "ou_alice" },
    });
  });
  it("tells an inferred ticket that inferred work is no longer accepted when the accept mode leaves auto, and names a bot it is for", () => {
    const auto = { ...base, eval: { ...base.eval, mode: "auto" as const } };
    const observe = { ...base, eval: { ...base.eval, mode: "observe" as const } };
    const rule = ticket("t3", {
      strength: "inferred",
      actor: { source: "feishu", id: "ou_alice" },
      basis: { via: "listed", source: "feishu", rules: ["copy"], observation: {} },
    });
    const effects = policyEffects([rule, explicit], auto, observe, scope);
    // Not a sender's removal: the person who wrote it may still start work.
    expect(effects.get("t3")).toEqual({ proactive: false });
    expect(effects.has("t2")).toBe(false);
    const bot = ticket("t4", {
      strength: "explicit",
      actor: { source: "feishu", id: "cli_ci_bot" },
      basis: { via: "listed", source: "feishu" },
    });
    const listed = {
      ...base,
      policy: {
        ...base.policy,
        sources: {
          ...base.policy.sources,
          feishu: { ...base.policy.sources.feishu!, allowed: [{ id: "cli_ci_bot" }] },
        },
      },
    };
    expect(policyEffects([bot], listed, base, scope).get("t4")).toEqual({
      requesterAllowed: false,
      requester: { source: "feishu", id: "cli_ci_bot" },
    });
  });
  it("keeps an inferred follow-up's Mandate only while candidates become work and its rules are on, as any inferred one", () => {
    const followup = ticket("t5", {
      strength: "inferred",
      actor: { source: "feishu", id: "ou_guest" },
      basis: { via: "followup", source: "feishu", scope: { chatId: "oc_team" }, rules: ["copy"] },
    });
    const mode = (value: "auto" | "observe" | "off") => ({ ...base, eval: { ...base.eval, mode: value } });
    const disabled = {
      ...mode("auto"),
      policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== "copy" })) },
    };
    expect(settingsPolicy(mode("auto"), scope()).revalidate(followup.mandate)).toBe(true);
    for (const settings of [mode("observe"), mode("off"), disabled])
      expect(settingsPolicy(settings, scope()).revalidate(followup.mandate)).toBe(false);
    expect(policyEffects([followup], mode("auto"), mode("observe"), scope).get("t5")).toEqual({ proactive: false });
    // An explicit follow-up holds whatever the mode.
    const explicitFollowup = ticket("t6", {
      ...followup.mandate,
      strength: "explicit",
      actor: { source: "feishu", id: "ou_alice" },
    });
    expect(settingsPolicy(mode("off"), scope()).revalidate(explicitFollowup.mandate)).toBe(true);
  });
  it("revokes an inferred ticket whose cell weakens or whose candidates no longer become work, and reports a deleted rule disabled", () => {
    const chat = "oc_1111111111111111111111111111";
    const table = (cell: "inferred" | "ignore", mode: "auto" | "observe" = "auto") =>
      SettingsSchema.parse({
        ...base,
        eval: { ...base.eval, mode },
        policy: {
          ...base.policy,
          sources: { feishu: { ...base.policy.sources.feishu!, admission: { [chat]: { unlistedUnaddressed: cell } } } },
        },
      });
    const observed = () => ({ scope: () => ({ listened: true as const, observed: true, row: chat }) });
    const proactive = ticket("t3", {
      strength: "inferred",
      actor: { source: "feishu", id: "ou_guest" },
      basis: {
        via: "admission",
        cell: "unlistedUnaddressed",
        source: "feishu",
        scope: { chatId: chat },
        row: chat,
        rules: ["copy"],
        observation: { mode: "auto" },
      },
    });
    expect(policyEffects([proactive], table("inferred"), table("inferred"), observed).size).toBe(0);
    // A weaker cell takes the work from its sender, whom the effect names; a mode change only stops inferred work.
    expect(policyEffects([proactive], table("inferred"), table("ignore"), observed).get("t3")).toEqual({
      requesterAllowed: false,
      requester: { source: "feishu", id: "ou_guest" },
    });
    expect(policyEffects([proactive], table("inferred"), table("inferred", "observe"), observed).get("t3")).toEqual({
      proactive: false,
    });
    const deleted = {
      ...base,
      policy: { ...base.policy, rules: base.policy.rules.filter(rule => rule.id !== "visual") },
    };
    const visual = ticket("t4", {
      strength: "explicit",
      actor: { source: "feishu", id: "ou_alice" },
      basis: { via: "listed", source: "feishu", rules: ["visual"] },
    });
    expect(policyEffects([visual], base, deleted, scope).get("t4")).toEqual({
      rules: [{ id: "visual", name: "Visual", change: "disabled" }],
    });
  });
});

describe("bots and events without a sender", () => {
  const observing = (
    config: Record<string, unknown>,
    part: Record<string, unknown> = {},
    mode: "auto" | "off" = "auto",
  ) =>
    SettingsSchema.parse({
      policy: { sources: { github: { allowed: [{ id: "Alice" }], bots: [{ id: "dependabot[bot]" }], ...part } } },
      eval: { mode },
      sources: { github: { enabled: true, config } },
    });
  const comment: Trigger = {
    id: "b",
    source: "github",
    threads: [{ source: "github", id: "1" }],
    actor: { source: "github", id: "dependabot[bot]" },
    human: false,
    at: "",
    text: "Bump lodash",
    meta: { number: 1, isPr: true, kind: "conversation" },
  };
  const ci = (meta: Record<string, unknown>): Trigger => ({
    id: "ci",
    source: "github",
    threads: [{ source: "github", id: "ci:main" }],
    actor: { source: "github", id: "" },
    human: false,
    at: "",
    text: "CI failed 1/9 on main",
    meta: { ci: true, ...meta },
  });
  it("admits a bot on its Source's list as an inferred candidate where the Source observes its scope, and no other bot", () => {
    const { policy } = setup(observing({ observeComments: true }));
    expect(policy.gate(comment, thread(), [])).toMatchObject({
      admissible: true,
      strength: "inferred",
      basis: {
        via: "bot",
        source: "github",
        sender: "dependabot[bot]",
        row: "comments",
        observation: { mode: "auto" },
      },
    });
    // A bot that addresses the agent still makes no explicit request; on a Thread with tickets it is no follow-up either.
    expect(policy.gate({ ...comment, addressed: "mention" }, thread(["ticket"]), [ticket])).toMatchObject({
      strength: "inferred",
      basis: { via: "bot", addressed: "mention" },
    });
    expect(policy.gate({ ...comment, actor: { source: "github", id: "renovate[bot]" } }, thread(), [])).toEqual({
      admissible: false,
      reason: "not_human",
    });
    expect(setup(observing({})).policy.gate(comment, thread(), [])).toEqual({ admissible: false, reason: "not_human" });
    expect(setup(observing({ observeComments: true }, {}, "off")).policy.gate(comment, thread(), [])).toEqual({
      admissible: false,
      reason: "admission_ignored",
    });
  });
  it("keeps a bot candidate's Mandate while the bot stays on its list and candidates may become work", () => {
    const settings = observing({ observeComments: true });
    const mandate = {
      strength: "inferred" as const,
      policyVersion: "",
      actor: comment.actor,
      scope: "",
      basis: {
        via: "bot" as const,
        source: "github",
        scope: comment.meta,
        row: "comments",
        sender: "dependabot[bot]",
        observation: { mode: "auto" as const },
      },
    };
    expect(setup(settings).policy.revalidate(mandate)).toBe(true);
    expect(setup(observing({ observeComments: true }, { bots: [] })).policy.revalidate(mandate)).toBe(false);
    expect(setup({ ...settings, eval: { ...settings.eval, mode: "observe" } }).policy.revalidate(mandate)).toBe(false);
  });
  it("admits the default branch's CI through its row once observed and set, and never a PR's CI", () => {
    const admission = { ci: { unlistedUnaddressed: "inferred" } };
    const branch = setup(observing({ observeCi: true }, { admission })).policy.gate(
      ci({ branch: "main" }),
      thread(),
      [],
    );
    expect(branch).toMatchObject({
      admissible: true,
      strength: "inferred",
      basis: { via: "admission", cell: "unlistedUnaddressed", row: "ci", observation: { mode: "auto" } },
    });
    // The cell defaults to ignore, so observing the CI changes nothing until the table says so.
    expect(setup(observing({ observeCi: true })).policy.gate(ci({ branch: "main" }), thread(), [])).toEqual({
      admissible: false,
      reason: "admission_ignored",
    });
    const pull = setup(observing({ observeCi: true }, { admission })).policy.gate(
      ci({ number: 9, isPr: true }),
      thread(),
      [],
    );
    expect(pull).toEqual({ admissible: false, reason: "not_human" });
  });
  it("admits a Feishu bot on its list in a chat the Source observes", () => {
    const settings = SettingsSchema.parse({
      ...base,
      policy: {
        ...base.policy,
        sources: {
          ...base.policy.sources,
          feishu: { ...base.policy.sources.feishu, bots: [{ id: "cli_alerts", name: "Alerts" }] },
        },
      },
    });
    const alert = unaddressed({
      actor: { source: "feishu", id: "cli_alerts" },
      human: false,
      meta: { chatId: OBSERVED, direct: false, mentioned: false },
    });
    expect(setup(settings).policy.gate(alert, thread(), [])).toMatchObject({
      admissible: true,
      strength: "inferred",
      basis: { via: "bot", sender: "Alerts", row: OBSERVED },
    });
    // In a chat the Source receives only mentions in, a bot's message that does not address the agent is not received.
    const unobserved = setup(settings).policy.gate(
      { ...alert, meta: { chatId: CHAT, direct: false, mentioned: false } },
      thread(),
      [],
    );
    expect(unobserved).toEqual({ admissible: false, reason: "not_human" });
  });
  it("says on the GitHub bot list when a listed bot's comment is received: when it mentions the agent, or comments are observed", () => {
    const field = githubKind.policy!.fields.find(item => item.key === "bots")!;
    const comments = githubKind.fields.find(item => item.key === "observeComments")!.label;
    expect(field.hint!.en).toContain("mentions the agent");
    expect(field.hint!.en).toContain(comments.en);
    expect(field.hint!.zh).toContain(comments.zh);
  });
  it("names a GitHub Trigger's receiving scope, which the Source observes where its switch is on", () => {
    const { sources } = setup(observing({ observeIssues: true }));
    const github = (meta: Record<string, unknown>) => ({ source: "github", meta });
    expect(sources.scope(github({ kind: "issue", number: 3 }))).toEqual({
      listened: true,
      observed: true,
      row: "issues",
    });
    expect(sources.scope(github({ kind: "pull", number: 4, isPr: true }))).toEqual({
      listened: true,
      observed: false,
      row: "pulls",
    });
    expect(sources.scope(github({ kind: "inline", number: 4 }))).toEqual({
      listened: true,
      observed: false,
      row: "comments",
    });
    expect(sources.scope(github({ ci: true, branch: "main" }))).toEqual({ listened: true, observed: false, row: "ci" });
    expect(sources.scope(github({ ci: true, number: 4 }))).toEqual({ listened: true, observed: false });
    const rows = githubKind.policy!.rows!({ observeIssues: true });
    expect(rows.map(row => [row.id, row.cells])).toEqual([
      ["issues", { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true }],
      ["pulls", { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ["comments", { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }],
      ["ci", { listedUnaddressed: false, unlistedAddressed: false, unlistedUnaddressed: false }],
    ]);
  });
});
