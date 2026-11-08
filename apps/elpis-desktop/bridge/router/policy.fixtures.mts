import { SettingsSchema, settingsPolicy, policyVersion, type Settings } from "./policy.mts";
import { SourceRegistry } from "./sources/registry.mts";
import { testChatKind as feishuKind } from "./fixtures/chat-kind.mts";
import { githubKind } from "./sources/github.mts";
import type { Thread, Ticket, Trigger } from "./core/index.mts";

export const MEMBER = "ou_alice";

export const CHAT = "oc_team";

export const OBSERVED = "oc_1111111111111111111111111111";

export const feishuSource = (
  config: { chats: { chatId: string; listen: "mentions" | "all" }[]; directMessages: boolean },
  enabled = true,
) => ({ enabled, config });

export const base = SettingsSchema.parse({
  policy: {
    sources: {
      feishu: { allowed: [{ id: MEMBER, name: "Alice" }], syncChat: CHAT },
      github: { allowed: [{ id: "Alice" }] },
    },
  },
  eval: { mode: "auto" },
  sources: {
    feishu: feishuSource({
      chats: [
        { chatId: CHAT, listen: "mentions" },
        { chatId: OBSERVED, listen: "all" },
      ],
      directMessages: true,
    }),
  },
});

export function setup(settings: Settings = base) {
  const sources = new SourceRegistry(() => settings);
  sources.register(feishuKind);
  sources.register(githubKind);
  return { sources, policy: settingsPolicy(settings, sources), version: policyVersion(settings) };
}

export const { sources, policy } = setup();

export const thread = (subscriptions: string[] = []): Thread => ({
  key: "feishu:x",
  ref: { source: "feishu", id: "x" },
  createdAt: "",
  subscriptions,
  correlated: [],
  pending: [],
  meta: {},
});

export const feishu = (overrides: Partial<Trigger> & { meta?: Record<string, unknown> } = {}): Trigger => ({
  id: "t",
  source: "feishu",
  threads: [{ source: "feishu", id: "x" }],
  actor: { source: "feishu", id: MEMBER },
  human: true,
  at: "",
  text: "hi",
  addressed: "mention",
  meta: { chatId: CHAT, direct: false, mentioned: true },
  ...overrides,
});

export const unaddressed = (overrides: Partial<Trigger> = {}): Trigger => {
  const { addressed: _addressed, ...rest } = feishu(overrides);
  return rest;
};

export const github = (login: string, addressed?: "mention"): Trigger => ({
  id: "g",
  source: "github",
  threads: [{ source: "github", id: "1" }],
  actor: { source: "github", id: login },
  human: true,
  at: "",
  text: "x",
  ...(addressed ? { addressed } : {}),
  meta: { number: 1, isPr: true },
});

export const ticket = { id: "ticket", ended: { at: "", by: "executor", reason: "closed", outcome: "closed" } } as Ticket;
