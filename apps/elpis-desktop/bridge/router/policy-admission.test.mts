import { describe, it } from "node:test";
import { expect } from "expect";
import { SettingsSchema, allowedSender, anyoneAllowed } from "./policy.mts";
import type { MandateBasis } from "./core/index.mts";
import { SourceRegistry } from "./sources/registry.mts";
import { testChatKind as feishuKind } from "./fixtures/chat-kind.mts";
import type { Trigger } from "./core/index.mts";
import { MEMBER, CHAT, OBSERVED, feishuSource, base, setup, sources, policy, thread, feishu, unaddressed, github, ticket } from "./policy.fixtures.mts";

it("worker capacity is a positive safe integer setting, with the reference default and no arbitrary ceiling", () => {
  expect(SettingsSchema.parse({}).executor.maxWorkers).toBe(3);
  for (const maxWorkers of [1, 17, 1000])
    expect(SettingsSchema.parse({ executor: { maxWorkers } }).executor.maxWorkers).toBe(maxWorkers);
  for (const maxWorkers of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(SettingsSchema.safeParse({ executor: { maxWorkers } }).success).toBe(false);
});

describe("source scope", () => {
  it("listens to configured chats, reads every message only where configured, and follows the direct-message switch", () => {
    expect(sources.scope(feishu())).toEqual({ listened: true, observed: false, row: CHAT });
    expect(sources.scope(feishu({ meta: { chatId: OBSERVED, direct: false, mentioned: false } }))).toEqual({
      listened: true,
      observed: true,
      row: OBSERVED,
    });
    expect(sources.scope(feishu({ meta: { chatId: "oc_other", direct: false, mentioned: true } }))).toEqual({
      listened: false,
      reason: "chat_not_allowed",
    });
    expect(sources.scope(feishu({ meta: { chatId: "p2p", direct: true, mentioned: false } }))).toEqual({
      listened: true,
      observed: false,
      row: "direct",
    });
    expect(
      setup({ ...base, sources: { feishu: feishuSource({ chats: [], directMessages: false }) } }).sources.scope(
        feishu({ meta: { chatId: "p2p", direct: true, mentioned: false } }),
      ),
    ).toEqual({ listened: false, reason: "direct_messages_not_allowed" });
    expect(sources.scope(github("anyone"))).toEqual({ listened: true, observed: false });
  });
  it("listens to nothing from a configured Source whose plugin is not loaded, and keeps an invalid stored configuration disabled", () => {
    const bare = new SourceRegistry(() => base);
    expect(bare.scope(feishu())).toEqual({ listened: false, reason: "source_not_installed" });
    expect(bare.scope(github("anyone"))).toEqual({ listened: true, observed: false });
    const broken = new SourceRegistry(() =>
      SettingsSchema.parse({ sources: { feishu: { enabled: true, config: { chats: "oops" } } } }),
    );
    broken.register(feishuKind);
    expect(broken.instance("feishu")).toMatchObject({ enabled: false });
    expect(broken.scope(feishu())).toEqual({ listened: false, reason: "source_disabled" });
  });
  it("filters everything from a disabled Source", () => {
    expect(
      setup({ ...base, sources: { ...base.sources, github: { enabled: false, config: {} } } }).sources.scope(
        github("anyone"),
      ),
    ).toEqual({ listened: false, reason: "source_disabled" });
  });
});

describe("gate", () => {
  it("grants explicit strength when the sender is allowed in its Source's part and the Source marked the Trigger addressed", () => {
    expect(policy.gate(feishu(), thread(), [])).toMatchObject({
      admissible: true,
      strength: "explicit",
      basis: { via: "addressed", source: "feishu", sender: "Alice", addressed: "mention", scope: { chatId: CHAT } },
    });
    expect(
      policy.gate(
        feishu({ addressed: "direct", meta: { chatId: "p2p", direct: true, mentioned: false } }),
        thread(),
        [],
      ),
    ).toMatchObject({ admissible: true, strength: "explicit", basis: { addressed: "direct" } });
    // GitHub logins compare without case; the entry's id names the sender when it has no display name.
    expect(policy.gate(github("alice", "mention"), thread(), [])).toMatchObject({
      admissible: true,
      strength: "explicit",
      basis: { source: "github", sender: "Alice" },
    });
  });
  it("checks each Source's own list: a Feishu id allows nothing on GitHub", () => {
    expect(policy.gate(github(MEMBER, "mention"), thread(), [])).toEqual({ admissible: false, reason: "not_a_member" });
    expect(allowedSender(base, { source: "github", id: "ALICE" })).toEqual({ id: "Alice" });
    expect(allowedSender(base, { source: "feishu", id: "Alice" })).toBeUndefined();
    expect(anyoneAllowed(base)).toBe(true);
    expect(anyoneAllowed(SettingsSchema.parse({}))).toBe(false);
  });
  it("assesses follow-ups on Threads with Tickets, explicit from an allowed sender and inferred from anyone else", () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } };
    expect(
      policy.gate(unaddressed({ ...quiet, actor: { source: "feishu", id: "ou_guest" } }), thread(["ticket"]), []),
    ).toMatchObject({ admissible: true, strength: "inferred", basis: { via: "followup" } });
    expect(policy.gate(unaddressed(quiet), thread(["ticket"]), [])).toMatchObject({
      admissible: true,
      strength: "explicit",
      basis: { via: "followup", sender: "Alice" },
    });
    expect(policy.gate(github("someone"), thread(), [ticket])).toMatchObject({
      admissible: true,
      strength: "inferred",
    });
    // A Thread a ticket follows only for context lends no follow-up: the admission table decides, as on any Thread.
    const context = { ...thread(["ticket"]), context: ["ticket"] };
    expect(policy.gate(unaddressed(quiet), context, [ticket])).toMatchObject({ admissible: false });
  });
  it("infers strength for allowed senders' messages the Source observes, unless Eval is off", () => {
    const observed = unaddressed({ meta: { chatId: OBSERVED, direct: false, mentioned: false } });
    expect(policy.gate(observed, thread(), [])).toMatchObject({
      admissible: true,
      strength: "inferred",
      basis: { via: "admission", observation: { mode: "auto" } },
    });
    expect(setup({ ...base, eval: { ...base.eval, mode: "off" } }).policy.gate(observed, thread(), [])).toEqual({
      admissible: false,
      reason: "no_mention",
    });
  });
  it("admits no direct message from a sender the Source's part does not allow, not even as a follow-up", () => {
    expect(
      policy.gate(
        feishu({
          actor: { source: "feishu", id: "ou_guest" },
          addressed: "direct",
          meta: { chatId: "p2p", direct: true, mentioned: false },
        }),
        thread(["ticket"]),
        [],
      ),
    ).toEqual({ admissible: false, reason: "not_a_member" });
  });
  it("rejects automated messages, unknown senders without a Thread, and allowed senders who did not address the agent", () => {
    expect(policy.gate(feishu({ human: false }), thread(), [])).toEqual({ admissible: false, reason: "not_human" });
    expect(policy.gate(feishu({ actor: { source: "feishu", id: "ou_guest" } }), thread(), [])).toEqual({
      admissible: false,
      reason: "not_a_member",
    });
    expect(policy.gate(unaddressed({ meta: { chatId: CHAT, direct: false, mentioned: false } }), thread(), [])).toEqual(
      { admissible: false, reason: "no_mention" },
    );
  });
});

describe("admission table", () => {
  const STRANGER = "ou_stranger";
  const withTable = (
    admission: Record<string, Record<string, string>>,
    config: Record<string, unknown> = {},
    mode: "off" | "observe" | "auto" = "auto",
  ) =>
    SettingsSchema.parse({
      ...base,
      eval: { ...base.eval, mode },
      sources: { ...base.sources, feishu: { enabled: true, config: { ...base.sources.feishu!.config, ...config } } },
      policy: {
        ...base.policy,
        sources: { ...base.policy.sources, feishu: { ...base.policy.sources.feishu!, admission } },
      },
    });
  const inChat = (chatId: string, sender = MEMBER, addressed = true): Trigger => {
    const message = feishu({
      actor: { source: "feishu", id: sender },
      meta: { chatId, direct: false, mentioned: addressed },
    });
    if (addressed) return message;
    const { addressed: _addressed, ...rest } = message;
    return rest;
  };
  it("reproduces the behaviour before the table with every cell unset", () => {
    expect(policy.gate(inChat(OBSERVED, MEMBER, false), thread(), [])).toMatchObject({
      admissible: true,
      strength: "inferred",
      basis: { via: "admission", row: OBSERVED, cell: "listedUnaddressed", observation: { mode: "auto" } },
    });
    expect(policy.gate(inChat(CHAT, STRANGER), thread(), [])).toEqual({ admissible: false, reason: "not_a_member" });
    expect(
      policy.gate(
        feishu({
          actor: { source: "feishu", id: STRANGER },
          addressed: "direct",
          meta: { chatId: "p2p", direct: true, mentioned: false },
        }),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: "not_a_member" });
    // A listed sender who addresses the agent makes an explicit request whatever the table says.
    expect(
      setup(withTable({ [CHAT]: { unlistedAddressed: "ignore" } })).policy.gate(inChat(CHAT), thread(), []),
    ).toMatchObject({ admissible: true, strength: "explicit" });
  });
  it("makes an unlisted sender's mention explicit or inferred as the row says, and an inferred one waits for a mode that assesses", () => {
    const explicit = setup(withTable({ [CHAT]: { unlistedAddressed: "explicit" } })).policy.gate(
      inChat(CHAT, STRANGER),
      thread(),
      [],
    );
    expect(explicit).toEqual({
      admissible: true,
      strength: "explicit",
      basis: {
        source: "feishu",
        scope: { chatId: CHAT, direct: false, mentioned: true },
        row: CHAT,
        via: "admission",
        cell: "unlistedAddressed",
        addressed: "mention",
      },
    });
    expect(
      setup(withTable({ [CHAT]: { unlistedAddressed: "inferred" } })).policy.gate(inChat(CHAT, STRANGER), thread(), []),
    ).toMatchObject({ admissible: true, strength: "inferred", basis: { cell: "unlistedAddressed" } });
    expect(
      setup(withTable({ [CHAT]: { unlistedAddressed: "inferred" } }, {}, "off")).policy.gate(
        inChat(CHAT, STRANGER),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: "not_a_member" });
    expect(
      setup(withTable({ direct: { unlistedAddressed: "explicit" } })).policy.gate(
        feishu({
          actor: { source: "feishu", id: STRANGER },
          addressed: "direct",
          meta: { chatId: "p2p", direct: true, mentioned: false },
        }),
        thread(),
        [],
      ),
    ).toMatchObject({ admissible: true, strength: "explicit", basis: { row: "direct", cell: "unlistedAddressed" } });
    expect(
      setup(withTable({ [OBSERVED]: { unlistedAddressed: "explicit" } })).policy.gate(
        inChat(CHAT, STRANGER),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: "not_a_member" });
  });
  it("ignores a listed sender's unaddressed message where the row says so, and never reads the table for messages the chat does not receive", () => {
    expect(
      setup(withTable({ [OBSERVED]: { listedUnaddressed: "ignore" } })).policy.gate(
        inChat(OBSERVED, MEMBER, false),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: "admission_ignored" });
    // An @-only chat receives no unaddressed message, so even an inferred cell does not admit one.
    expect(
      setup(withTable({ [CHAT]: { listedUnaddressed: "inferred" } })).policy.gate(
        inChat(CHAT, MEMBER, false),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: "no_mention" });
    expect(
      setup(withTable({ [CHAT]: { unlistedUnaddressed: "inferred" } })).policy.gate(
        inChat(CHAT, STRANGER, false),
        thread(),
        [],
      ),
    ).toEqual({ admissible: false, reason: "not_a_member" });
  });
  it("listens to mentions in chats that are not listed, as the row other, only when the Feishu card says so", () => {
    expect(sources.scope(inChat("oc_elsewhere"))).toEqual({ listened: false, reason: "chat_not_allowed" });
    const others = setup(withTable({ other: { unlistedAddressed: "explicit" } }, { otherChats: "mentions" }));
    expect(others.sources.scope(inChat("oc_elsewhere"))).toEqual({ listened: true, observed: false, row: "other" });
    expect(others.policy.gate(inChat("oc_elsewhere"), thread(), [])).toMatchObject({
      admissible: true,
      strength: "explicit",
      basis: { row: "other" },
    });
    expect(others.policy.gate(inChat("oc_elsewhere", STRANGER), thread(), [])).toMatchObject({
      admissible: true,
      strength: "explicit",
      basis: { row: "other", cell: "unlistedAddressed" },
    });
  });
  it("admits no inferred follow-up while Eval is off, as no other inferred candidate, and still a listed sender's", () => {
    const quiet = { meta: { chatId: CHAT, direct: false, mentioned: false } };
    const off = setup({ ...base, eval: { ...base.eval, mode: "off" } }).policy;
    expect(
      off.gate(unaddressed({ ...quiet, actor: { source: "feishu", id: "ou_guest" } }), thread(["ticket"]), []),
    ).toEqual({ admissible: false, reason: "not_a_member" });
    expect(off.gate(unaddressed(quiet), thread(["ticket"]), [])).toMatchObject({
      admissible: true,
      strength: "explicit",
      basis: { via: "followup" },
    });
  });
  it("makes an explicit request of an unlisted sender's message whose cell is explicit, also on a Thread with Tickets, in every mode", () => {
    for (const mode of ["auto", "observe", "off"] as const) {
      const open = setup(withTable({ [CHAT]: { unlistedAddressed: "explicit" } }, {}, mode));
      expect(open.policy.gate(inChat(CHAT, STRANGER), thread(["ticket"]), [])).toMatchObject({
        admissible: true,
        strength: "explicit",
        basis: { via: "admission", cell: "unlistedAddressed" },
      });
      // A cell that is not explicit leaves the follow-up inferred, while Eval is on.
      const strict = setup(withTable({ [CHAT]: { unlistedAddressed: "ignore" } }, {}, mode));
      expect(strict.policy.gate(inChat(CHAT, STRANGER), thread(["ticket"]), [])).toMatchObject(
        mode === "off" ? { admissible: false } : { admissible: true, strength: "inferred", basis: { via: "followup" } },
      );
    }
  });
  it("keeps follow-ups on a Thread with Tickets outside the table", () => {
    const strict = setup(withTable({ [OBSERVED]: { listedUnaddressed: "ignore", unlistedUnaddressed: "ignore" } }));
    expect(strict.policy.gate(inChat(OBSERVED, MEMBER, false), thread(["ticket"]), [])).toMatchObject({
      admissible: true,
      strength: "explicit",
      basis: { via: "followup" },
    });
    expect(strict.policy.gate(inChat(OBSERVED, STRANGER, false), thread(["ticket"]), [])).toMatchObject({
      admissible: true,
      strength: "inferred",
      basis: { via: "followup" },
    });
  });
  it("invalidates a Mandate once its cell gives less than the strength it was accepted with, and keeps it while the cell holds", () => {
    const open = withTable({ [CHAT]: { unlistedAddressed: "explicit" } });
    const gate = setup(open).policy.gate(inChat(CHAT, STRANGER), thread(), []);
    if (!gate.admissible) throw new Error("expected admission");
    const mandate = {
      strength: gate.strength,
      policyVersion: "v",
      basis: gate.basis,
      actor: { source: "feishu", id: STRANGER },
      scope: "",
    };
    expect(setup(open).policy.revalidate(mandate)).toBe(true);
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: "inferred" } })).policy.revalidate(mandate)).toBe(false);
    expect(setup(withTable({})).policy.revalidate(mandate)).toBe(false);
  });
  it("changes the Policy version when a cell changes", () => {
    expect(setup(withTable({ [CHAT]: { unlistedAddressed: "explicit" } })).version).not.toBe(setup().version);
    expect(setup(withTable({})).version).toBe(setup().version);
  });
});

describe("revalidating a Mandate from the admission table", () => {
  type Cell = "listedUnaddressed" | "unlistedAddressed" | "unlistedUnaddressed";
  const cells: Cell[] = ["listedUnaddressed", "unlistedAddressed", "unlistedUnaddressed"];
  const SENDER = "ou_sender";
  const origins: { cell: Cell; strength: "explicit" | "inferred" }[] = [
    { cell: "listedUnaddressed", strength: "inferred" },
    { cell: "unlistedAddressed", strength: "explicit" },
    { cell: "unlistedAddressed", strength: "inferred" },
    { cell: "unlistedUnaddressed", strength: "inferred" },
  ];
  const cases = origins.flatMap(origin =>
    [true, false].flatMap(listed =>
      (["off", "observe", "auto"] as const).flatMap(mode =>
        [true, false].flatMap(rule =>
          (["all", "mentions", "none"] as const).flatMap(scope =>
            [true, false].map(holds => ({ ...origin, listed, mode, rule, scope, holds })),
          ),
        ),
      ),
    ),
  );
  /** docs/002: the Thread must still be received; a listed sender who addresses the agent is explicit; a sender listed since takes the listed cell. */
  function expected({ cell, strength, listed, mode, rule, scope, holds }: (typeof cases)[number]): boolean {
    if (scope === "none") return false;
    if (cell === "unlistedAddressed" && listed) return true;
    const now = cell === "unlistedUnaddressed" && listed ? "listedUnaddressed" : cell;
    if ((now === "listedUnaddressed" && !listed) || !holds) return false;
    return strength === "explicit" || (mode === "auto" && rule);
  }
  for (const item of cases)
    it(JSON.stringify(item), () => {
      // The row gives each cell the strength the Mandate was accepted with, or, when it no longer holds, ignore.
      const grant = (cell: Cell) =>
        !item.holds ? "ignore" : cell === "unlistedAddressed" ? item.strength : "inferred";
      const chats = item.scope === "none" ? [] : [{ chatId: CHAT, listen: item.scope }];
      const settings = SettingsSchema.parse({
        eval: { mode: item.mode },
        sources: { feishu: feishuSource({ chats, directMessages: true }) },
        policy: {
          rules: [{ id: "copy", name: "Copy", enabled: item.rule, instruction: "x" }],
          sources: {
            feishu: {
              allowed: item.listed ? [{ id: SENDER }] : [],
              admission: { [CHAT]: Object.fromEntries(cells.map(cell => [cell, grant(cell)])) },
            },
          },
        },
      });
      const addressed = item.cell === "unlistedAddressed";
      const observed = item.strength === "inferred" ? { observation: { mode: "auto" as const }, rules: ["copy"] } : {};
      const basis: MandateBasis = {
        via: "admission",
        source: "feishu",
        scope: { chatId: CHAT, direct: false, mentioned: addressed },
        row: CHAT,
        cell: item.cell,
        ...(addressed ? { addressed: "mention" as const } : {}),
        ...observed,
      };
      const mandate = {
        strength: item.strength,
        policyVersion: "v",
        basis,
        actor: { source: "feishu", id: SENDER },
        scope: "",
      };
      expect(setup(settings).policy.revalidate(mandate)).toBe(expected(item));
    });
});
