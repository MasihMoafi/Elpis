// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/registry.spec.ts.
import { describe, it } from "node:test";
import { expect } from "expect";
import { z } from "zod";
import { SettingsSchema } from "../policy.mts";
import { SourceRegistry } from "./registry.mts";
import type { SourceKind } from "./kind.mts";
import type { OutboundMessage } from "../core/index.mts";
import { Commands } from "../infra/commands.mts";
import { HealthBoard } from "../infra/health.mts";
import { sourceContext as sourceContextOf } from "../source-context.mts";
import { testDeployment } from "../fixtures/deployment.mts";
import { fixture } from "../fixtures/app.mts";
import { createElpisChatKind } from "./elpis-chat.mts";
import { githubKind } from "./github.mts";

const probe: SourceKind<{ interval: number }> = {
  kind: "probe",
  title: { zh: "探针", en: "Probe" },
  description: { zh: "", en: "" },
  health: [],
  schema: z.object({ interval: z.number().int().min(1).default(5) }).strict(),
  fields: [{ key: "interval", type: "number", min: 1, max: 60, label: { zh: "间隔", en: "Interval" } }],
};

describe("Source registry", () => {
  it("lists every installed kind with defaults, in id order, followed by stored instances whose kind is not installed", () => {
    const settings = SettingsSchema.parse({
      sources: { probe: { enabled: false, config: { interval: 9 } }, retired: { enabled: true, config: { x: 1 } } },
    });
    const sources = new SourceRegistry(() => settings);
    sources.register(probe);
    sources.register(githubKind);
    expect(sources.instances()).toEqual([
      {
        id: "github",
        kind: "github",
        enabled: true,
        config: {
          repository: "",
          cli: "",
          pollSeconds: 60,
          failuresBeforeError: 3,
          observeIssues: false,
          observePulls: false,
          observeComments: false,
          observeCi: false,
        },
        installed: true,
      },
      { id: "probe", kind: "probe", enabled: false, config: { interval: 9 }, installed: true },
      { id: "retired", kind: "retired", enabled: true, config: { x: 1 }, installed: false },
    ]);
  });
  it("validates submitted instances with the kind schema and refuses kinds that are not installed", () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}));
    sources.register(probe);
    expect(sources.validate("probe", { enabled: true, config: {} })).toEqual({
      enabled: true,
      config: { interval: 5 },
    });
    expect(() => sources.validate("probe", { enabled: true, config: { interval: 0 } })).toThrow();
    expect(() => sources.validate("missing", { enabled: true, config: {} })).toThrow("not installed");
  });
  it("sends, links and reads a kind's Threads through its own channel and context, and nothing for a kind without them", async () => {
    const sources = new SourceRegistry(() =>
      SettingsSchema.parse({ sources: { probe: { enabled: true, config: { interval: 7 } } } }),
    );
    const sent: OutboundMessage[] = [];
    const read: unknown[] = [];
    sources.register({
      ...probe,
      channel: {
        send: async (_host, message) => {
          sent.push(message);
          return "sent";
        },
        link: address => ({ url: `https://probe/${address.room}`, label: { zh: "探针", en: "Probe" } }),
      },
      threadContext: {
        messageId: trigger => String(trigger.meta.id),
        read: async (_commands, trigger, part, cursor, config) => {
          read.push([trigger.id, part, cursor, config.interval]);
          return { messages: [{ id: "m1", from: "u", at: "1", text: "" }], body: { page: cursor ?? "first" } };
        },
      },
    });
    const commands = new Commands(testDeployment, {}, new AbortController().signal);
    const message = (source: string): OutboundMessage => ({
      id: "r1",
      channel: { source, thread: "probe:1", address: { room: "r" } },
      text: "hi",
      kind: "reply",
    });
    expect(await sources.send(message("probe"), commands)).toBe("sent");
    expect(sent).toEqual([message("probe")]);
    // A kind that is not installed keeps its replies waiting; links to it have no page.
    expect(await sources.send(message("retired"), commands)).toBe("waiting");
    expect(sources.link(message("probe").channel, {})).toEqual({
      url: "https://probe/r",
      label: { zh: "探针", en: "Probe" },
    });
    expect(sources.link(message("retired").channel, {})).toEqual({ url: "", label: { zh: "retired", en: "retired" } });
    const trigger = {
      id: "t1",
      source: "probe",
      threads: [{ source: "probe", id: "1" }],
      actor: { source: "probe", id: "u" },
      human: true,
      at: "",
      text: "hi",
      meta: { id: "m1" },
    };
    const context = sources.threadContext(trigger)!;
    expect(context.messageId).toBe("m1");
    expect(await context.read(commands, "thread", "2")).toMatchObject({ body: { page: "2" } });
    expect(read).toEqual([["t1", "thread", "2", 7]]);
    expect(context.images("img_x")).toEqual([]);
    await expect(
      context.image({}, commands, { id: "m1", text: "" }, "img_x", "", new AbortController().signal),
    ).rejects.toThrow("no images");
    // A kind without a channel or a context has neither.
    sources.register({ ...probe, kind: "quiet" });
    expect(await sources.send(message("quiet"), commands)).toBe("gone");
    expect(sources.threadContext({ ...trigger, source: "quiet" })).toBeUndefined();
  });
  it("refuses competing health writers and stops reports from old registrations", async t => {
    const h = fixture();
    t.after(() => h.close());
    const board = new HealthBoard();
    // Pre-claim built-in health entries; sync:* entries are reserved for settings sync.
    for (const name of ["runtime", "reply"]) board.claim(name);
    const sources = new SourceRegistry(() => SettingsSchema.parse({}), board);
    const unregister = sources.register(githubKind);
    expect(() => sources.register({ ...probe, health: ["github"] })).toThrow("declares the health entry github");
    for (const name of ["runtime", "reply", "sync:github"])
      expect(() => sources.register({ ...probe, health: ["probe", name] })).toThrow(name);
    expect(sources.kind("probe")).toBeUndefined();
    sources.register({ ...probe, health: ["probe"] });
    const context = (kind: { kind: string; health: readonly string[] }) =>
      sourceContextOf(
        {
          sources,
          store: h.app.store,
          outbox: h.app.outbox,
          engine: h.app.engine,
          commands: new Commands(testDeployment, {}, new AbortController().signal),
          deployment: testDeployment(),
          ready: Promise.resolve(),
          configured: () => true,
          receive: () => "stored",
        },
        kind,
      );
    const first = context(githubKind);
    first.report("github", { state: "ready", detail: "ok" });
    expect(board.all.github).toEqual({ state: "ready", detail: "ok" });
    expect(() => first.report("probe", { state: "ready", detail: "" })).toThrow("has no health entry probe");
    // A report sent after its kind unregisters (such as from an exiting CLI listener) is ignored and does not affect a later registration.
    unregister();
    expect(() => first.report("github", { state: "error", detail: "WARN exiting" })).not.toThrow();
    expect(board.all.github).toBeUndefined();
    sources.register(githubKind);
    first.report("github", { state: "error", detail: "late" });
    expect(board.all.github).toEqual({ state: "starting", detail: "" });
    context(githubKind).report("github", { state: "ready", detail: "again" });
    expect(board.all.github).toEqual({ state: "ready", detail: "again" });
  });
  it("refuses a second registration of one kind and forgets a kind after its disposer runs", () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}));
    const dispose = sources.register(probe);
    expect(() => sources.register(probe)).toThrow("already registered");
    dispose();
    expect(sources.instance("probe")).toBeUndefined();
  });
});

it("Elpis chat policy, reply targets and reply-parent identities pass through the registry", async () => {
  const settings = SettingsSchema.parse({
    sources: { "elpis-chat": { enabled: true, config: { threadId: "mother" } } },
    policy: { sources: { "elpis-chat": { allowed: [{ id: "local-user" }] } } },
  });
  const sent: string[] = [],
    sources = new SourceRegistry(() => settings);
  sources.register(
    createElpisChatKind({
      read: async () => [],
      appendAssistant: async (thread, reply) => {
        sent.push(`${thread}:${reply.id}`);
        return "sent";
      },
    }),
  );
  expect(sources.validatePolicy({ "elpis-chat": { allowed: [{ id: "local-user" }] } })).toEqual({
    "elpis-chat": { allowed: [{ id: "local-user" }], admission: {} },
  });
  expect(() => sources.validatePolicy({ "elpis-chat": { allowed: "invalid" } })).toThrow();
  expect(sources.channelAllowed({ source: "elpis-chat", address: { threadId: "mother" } })).toBe(true);
  expect(sources.channelAllowed({ source: "elpis-chat", address: { threadId: "other" } })).toBe(false);
  const message: OutboundMessage = {
    id: "reply",
    kind: "reply",
    text: "Done",
    channel: { source: "elpis-chat", thread: "elpis-chat:mother", address: { threadId: "mother" } },
  };
  expect(await sources.send(message, new Commands(testDeployment, {}, new AbortController().signal))).toBe("sent");
  expect(sent).toEqual(["mother:reply"]);
});
