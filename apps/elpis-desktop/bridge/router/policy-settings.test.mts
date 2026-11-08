import { describe, it } from "node:test";
import { expect } from "expect";
import { SettingsSchema, assessmentOutcome, settingsPolicy } from "./policy.mts";
import type { MandateBasis } from "./core/index.mts";
import { migrateSettings } from "./app/migration.mts";
import { MEMBER, CHAT, OBSERVED, feishuSource, base, setup, sources, policy, thread, feishu } from "./policy.fixtures.mts";

describe("revalidate and version", () => {
  it("keeps explicit Mandates while the sender stays allowed and the Source still listens, and rule Mandates only while auto mode and the rules hold", () => {
    const basis: MandateBasis = {
      via: "addressed",
      source: "feishu",
      scope: { chatId: CHAT, direct: false },
      sender: "Alice",
      addressed: "mention",
    };
    const mandate = {
      strength: "explicit" as const,
      policyVersion: "v",
      basis,
      actor: { source: "feishu", id: MEMBER },
      scope: "",
    };
    expect(policy.revalidate(mandate)).toBe(true);
    const nobody = { ...base, policy: { ...base.policy, sources: {} } };
    expect(setup(nobody).policy.revalidate(mandate)).toBe(false);
    const silent = { ...base, sources: { feishu: feishuSource({ chats: [], directMessages: true }) } };
    expect(setup(silent).policy.revalidate(mandate)).toBe(false);
    // A Mandate from before the gate recorded how it admitted a Trigger holds while its sender is listed and the Source listens.
    const listed: MandateBasis = {
      via: "listed",
      source: "feishu",
      scope: { chatId: CHAT, direct: false },
      sender: "Alice",
    };
    expect(setup(silent).policy.revalidate({ ...mandate, basis: listed })).toBe(false);
    expect(policy.revalidate({ ...mandate, basis: listed })).toBe(true);
    const inferred = {
      ...mandate,
      strength: "inferred" as const,
      basis: { via: "listed", observation: {}, rules: ["copy"] } satisfies MandateBasis,
    };
    expect(policy.revalidate(inferred)).toBe(true);
    expect(setup({ ...base, eval: { ...base.eval, mode: "observe" } }).policy.revalidate(inferred)).toBe(false);
    expect(
      setup({
        ...base,
        policy: { ...base.policy, rules: base.policy.rules.map(rule => ({ ...rule, enabled: rule.id !== "copy" })) },
      }).policy.revalidate(inferred),
    ).toBe(false);
    expect(setup(nobody).policy.revalidate({ ...mandate, basis: { via: "followup" } })).toBe(true);
  });
  it("changes the Policy version for rules, accept mode and the Sources' parts, not for pause, concurrency, models or Source configuration", () => {
    const version = setup().version;
    expect(
      setup({
        ...base,
        paused: true,
        executor: { ...base.executor, maxWorkers: 9 },
        eval: { ...base.eval, timeoutSeconds: 300 },
        sources: { ...base.sources, github: { enabled: true, config: { pollSeconds: 600 } } },
      }).version,
    ).toBe(version);
    expect(setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).version).toBe(
      version,
    );
    expect(setup({ ...base, eval: { ...base.eval, mode: "off" } }).version).not.toBe(version);
    expect(
      setup({
        ...base,
        policy: { ...base.policy, sources: { ...base.policy.sources, github: { allowed: [], admission: {} } } },
      }).version,
    ).not.toBe(version);
  });
});

describe("settings migration", () => {
  it("moves each member's identity into each Source's part of the Policy and drops the fields prompts and the execution environment replaced", () => {
    const saved = SettingsSchema.parse(
      migrateSettings({
        policy: {
          members: [
            { name: "Alice", feishuId: MEMBER, github: "alice" },
            { name: "Bob", feishuId: "ou_bob", github: "" },
            { name: "Carol", feishuId: "", github: "carol" },
          ],
          memberChat: CHAT,
          autoMergeLineLimit: 300,
          rules: [{ id: "visual", name: "V", enabled: true, visual: true, instruction: "x" }],
        },
        executor: { maxWorkers: 2, reviewer: "dave", visualReviewer: "carol", branchPrefix: "bot/" },
        sources: { feishu: { enabled: true, config: { chats: [], directMessages: true }, authority: { chats: [] } } },
      }),
    );
    expect(saved.policy).toEqual({
      rules: [{ id: "visual", name: "V", enabled: true, instruction: "x" }],
      sources: {
        feishu: {
          allowed: [
            { id: MEMBER, name: "Alice" },
            { id: "ou_bob", name: "Bob" },
          ],
          syncChat: CHAT,
          admission: {},
        },
        github: { allowed: [{ id: "alice" }, { id: "carol" }], admission: {} },
      },
    });
    expect(saved).toMatchObject({
      paused: false,
      executor: { model: null, maxWorkers: 2, directory: "", prepare: "", blockedCommands: [] },
    });
    expect(saved.sources.feishu).toEqual({ enabled: true, config: { chats: [], directMessages: true } });
    expect(SettingsSchema.parse(migrateSettings(saved))).toEqual(saved);
    expect(SettingsSchema.parse(migrateSettings({ executor: { maxWorkers: 2, paused: true } }))).toMatchObject({
      paused: true,
      executor: { maxWorkers: 2 },
    });
  });
  it("moves pre-domain chat lists into the Feishu Source, the pause into a setting of its own, and members into the Sources' parts", () => {
    const migrated = SettingsSchema.parse(
      migrateSettings({
        paused: true,
        allowedChats: [CHAT, OBSERVED],
        allowDirectMessages: false,
        pollSeconds: 120,
        maxWorkers: 5,
        members: [{ name: "A", feishuId: MEMBER, github: "a" }],
        models: { orchestrator: { provider: "p", model: "m" }, worker: null, admission: null },
        admission: { mode: "auto", chats: [OBSERVED], maxEvaluators: 1, timeoutSeconds: 90, rules: [] },
      }),
    );
    expect(migrated).toEqual({
      paused: true,
      sources: {
        feishu: feishuSource({
          chats: [
            { chatId: CHAT, listen: "mentions" },
            { chatId: OBSERVED, listen: "all" },
          ],
          directMessages: false,
        }),
        github: { enabled: true, config: { pollSeconds: 120 } },
      },
      policy: {
        rules: [],
        sources: {
          feishu: { allowed: [{ id: MEMBER, name: "A" }], admission: {} },
          github: { allowed: [{ id: "a" }], admission: {} },
        },
      },
      eval: { mode: "auto", timeoutSeconds: 90, model: { provider: "p", model: "m" } },
      executor: { model: null, maxWorkers: 5, directory: "", prepare: "", blockedCommands: [] },
    });
    expect(migrateSettings(migrated)).toEqual(migrated);
  });
  it("leaves chats that were observed only while admission was off outside the Feishu Source", () => {
    const migrated = SettingsSchema.parse(
      migrateSettings({ allowedChats: [CHAT], members: [], admission: { mode: "off", chats: [OBSERVED] } }),
    );
    expect(migrated.sources.feishu!.config).toEqual({
      chats: [{ chatId: CHAT, listen: "mentions" }],
      directMessages: true,
    });
  });
});

it("renames the variables a stored prepare command reads from earlier project names to the current one", () => {
  const settings = SettingsSchema.parse(
    migrateSettings({
      executor: {
        prepare: 'git worktree add "$DSH_TAG_DIR" -b "agent/${DSH_GO_NAME}" "refs/x/$DSH_FREELANCER_TICKET"',
      },
    }),
  );
  expect(settings.executor.prepare).toBe(
    'git worktree add "$DSH_SUPERAGENT_DIR" -b "agent/${DSH_SUPERAGENT_NAME}" "refs/x/$DSH_SUPERAGENT_TICKET"',
  );
});

it("reads a stored GitHub Source configuration that names a merge account without it", () => {
  const settings = SettingsSchema.parse(
    migrateSettings({
      sources: {
        github: {
          enabled: true,
          config: { repository: "acme/widgets", cli: "gh-agent", mergeCli: "gh-merge-account", pollSeconds: 120 },
        },
      },
    }),
  );
  expect(settings.sources.github!.config).toEqual({ repository: "acme/widgets", cli: "gh-agent", pollSeconds: 120 });
});

describe("assessment outcomes", () => {
  const settings = (mode: "auto" | "observe") => {
    const parsed = SettingsSchema.parse({});
    return { ...parsed, eval: { ...parsed.eval, mode } };
  };
  const direction = {
    implementation_requested: true,
    target_basis: "specified",
    requires_design_decision: false,
    evidence: "asked",
  };
  const judged = (current: ReturnType<typeof settings>, matched: boolean) =>
    current.policy.rules.filter(rule => rule.enabled).map(rule => ({ rule_id: rule.id, matched, reason: "judged" }));
  const accept = (current: ReturnType<typeof settings>, matched = true) => ({
    decision: "accept" as const,
    rule_assessments: judged(current, matched),
    direction,
    title: "Fix",
    scope: "small",
    reason: "asked",
    intent_evidence: "quote",
    worktree_name: "fix-copy",
  });
  it("accepts an inferred candidate on its matched rules in auto mode only, and the Policy admits only enabled matched rules", () => {
    const auto = settings("auto");
    const outcome = assessmentOutcome(accept(auto), auto, "inferred");
    expect(outcome).toMatchObject({
      kind: "accept",
      rules: auto.policy.rules.filter(rule => rule.enabled).map(rule => rule.id),
      name: "fix-copy",
    });
    expect(assessmentOutcome(accept(settings("observe")), settings("observe"), "inferred")).toMatchObject({
      kind: "ignore",
      reason: { code: "observed", values: { text: "asked" } },
      audit: { would_accept: true },
    });
    expect(assessmentOutcome(accept(auto, false), auto, "inferred")).toMatchObject({
      kind: "ignore",
      reason: { code: "noRuleMatched" },
    });
    expect(() => assessmentOutcome({ ...accept(auto), rule_assessments: [] }, auto, "inferred")).toThrow(
      "Exactly one assessment for every enabled rule",
    );
    expect(() => assessmentOutcome({ ...accept(auto), intent_evidence: null }, auto, "inferred")).toThrow(
      "Acceptance requires intent_evidence",
    );
    const scope = { scope: () => ({ listened: true as const, observed: true }) };
    const enabled = auto.policy.rules.find(rule => rule.enabled)!.id;
    expect(settingsPolicy(auto, scope).admitsInferred([enabled])).toBe(true);
    expect(settingsPolicy(auto, scope).admitsInferred(["unknown"])).toBe(false);
    expect(settingsPolicy(auto, scope).admitsInferred([])).toBe(false);
    expect(settingsPolicy(settings("observe"), scope).admitsInferred([enabled])).toBe(false);
  });
});

describe("admission table settings", () => {
  it("refuses an explicit cell for messages that do not address the agent, in the settings and in a submitted Policy", () => {
    for (const cell of ["listedUnaddressed", "unlistedUnaddressed"]) {
      const part = { allowed: [], admission: { [CHAT]: { [cell]: "explicit" } } };
      expect(() => SettingsSchema.parse({ policy: { sources: { feishu: part } } })).toThrow();
      expect(() => sources.validatePolicy({ feishu: part })).toThrow();
    }
    expect(
      sources.validatePolicy({ feishu: { allowed: [], admission: { [CHAT]: { unlistedAddressed: "explicit" } } } })
        .feishu,
    ).toMatchObject({ admission: { [CHAT]: { unlistedAddressed: "explicit" } } });
  });
  it("accepts an explicit candidate whatever the accept mode, which bears only on inferred ones", () => {
    const rules = SettingsSchema.parse({}).policy.rules.filter(rule => rule.enabled);
    const direction = {
      implementation_requested: true,
      target_basis: "specified",
      requires_design_decision: false,
      evidence: "asked",
    };
    const assessment = {
      decision: "accept" as const,
      direction,
      title: "Fix",
      scope: "small",
      reason: "asked",
      intent_evidence: "quote",
      rule_assessments: rules.map((rule, index) => ({ rule_id: rule.id, matched: index === 0, reason: "judged" })),
    };
    for (const mode of ["observe", "off"] as const) {
      const settings = SettingsSchema.parse({ eval: { mode } });
      expect(assessmentOutcome(assessment, settings, "explicit")).toMatchObject({ kind: "accept", title: "Fix" });
      expect(assessmentOutcome(assessment, settings, "inferred")).toMatchObject({
        kind: "ignore",
        reason: { code: "observed" },
      });
    }
  });
  it("admits a listed bot that mentions the agent where the Source does not observe its messages, as a listed person's mention needs none", () => {
    const settings = SettingsSchema.parse({
      ...base,
      policy: {
        ...base.policy,
        sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu, bots: [{ id: "cli_alerts" }] } },
      },
    });
    const mention = feishu({
      actor: { source: "feishu", id: "cli_alerts" },
      human: false,
      meta: { chatId: CHAT, direct: false, mentioned: true },
    });
    expect(setup(settings).policy.gate(mention, thread(), [])).toMatchObject({
      admissible: true,
      strength: "inferred",
      basis: { via: "bot", addressed: "mention", row: CHAT },
    });
  });
});

describe("rule judgements", () => {
  it("refuses an assessment that judges one enabled rule twice and leaves another unjudged", () => {
    const parsed = SettingsSchema.parse({
      eval: { mode: "auto" },
      policy: {
        rules: [
          { id: "copy", name: "Copy", enabled: true, instruction: "Fix typos." },
          { id: "visual", name: "Visual", enabled: true, instruction: "Fix colors." },
        ],
      },
    });
    const direction = {
      implementation_requested: true,
      target_basis: "specified",
      requires_design_decision: false,
      evidence: "asked",
    };
    const assessment = {
      decision: "accept" as const,
      direction,
      title: "Fix",
      scope: "small",
      reason: "asked",
      intent_evidence: "quote",
      rule_assessments: [
        { rule_id: "copy", matched: true, reason: "typo" },
        { rule_id: "copy", matched: false, reason: "again" },
      ],
    };
    expect(() => assessmentOutcome(assessment, parsed, "inferred")).toThrow(
      "Exactly one assessment for every enabled rule",
    );
    const once = {
      ...assessment,
      rule_assessments: [assessment.rule_assessments[0]!, { rule_id: "visual", matched: false, reason: "no colors" }],
    };
    expect(assessmentOutcome(once, parsed, "inferred")).toMatchObject({ kind: "accept", rules: ["copy"] });
  });
});
