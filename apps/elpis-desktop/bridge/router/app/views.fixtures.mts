import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "node:test";
import { Store } from "./store.mts";
import { SettingsSchema } from "../policy.mts";
import { SourceRegistry } from "../sources/registry.mts";
import { testChatKind as feishuKind } from "../fixtures/chat-kind.mts";
import { githubKind } from "../sources/github.mts";
import { overview } from "./views/overview.mts";
import { feishuLink } from "../fixtures/chat-kind.mts";
import { githubLink } from "../sources/github-channel.mts";
import { type ChannelRef } from "../core/index.mts";

export let directory: string;

export let store: Store;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "dsh-superagent-views-"));
  store = new Store(join(directory, "orchestrator.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});

export const links = (channel: ChannelRef) => (channel.source === "feishu" ? feishuLink : githubLink)(channel.address, {});

export const drop = (id: string, channel: ChannelRef, ticketId?: string) => {
  const message = { id, channel, text: id, kind: "reply" as const, ...(ticketId ? { ticketId } : {}) };
  store.receipts.add(message);
  store.receipts.settle(message, "channelGone");
};

export function views() {
  store.saveSettings(
    SettingsSchema.parse({
      policy: {
        sources: { feishu: { allowed: [{ id: "ou_alice", name: "Alice" }] }, github: { allowed: [{ id: "alice" }] } },
        rules: [{ id: "copy", name: "Copy fixes", enabled: true, instruction: "Fix copy" }],
      },
    }),
  );
  const sources = new SourceRegistry(() => store.settings());
  sources.register(feishuKind);
  sources.register(githubKind);
  return { store, sources, links };
}

export const at = new Date().toISOString();

/** A live ticket with no Assignment, as a follow-up's owner needs one. */
export const live = (id: string) =>
  store.tickets.save({
    id,
    title: id,
    decisionId: "d",
    channels: [],
    undelivered: [],
    createdAt: at,
    updatedAt: at,
    mandate: {
      strength: "explicit",
      policyVersion: "v",
      basis: { via: "listed" },
      actor: { source: "feishu", id: "ou_alice" },
      scope: "",
    },
    origin: { triggerId: "e0", triggerIds: ["e0"] },
    assignments: [],
    inputs: [],
  });

export const message = (id: string, actor: { source: string; id: string }, human = true) => ({
  id,
  source: actor.source,
  threads: [{ source: "feishu", id: "oc_1:om_root" }],
  actor,
  human,
  at,
  text: `message ${id}`,
  meta: {},
});

export const load = { running: 0, queued: 0 };

export const problems = (host: ReturnType<typeof views>, health: Parameters<typeof overview>[1] = {}) =>
  overview(host, health, "v1", load).problems;
