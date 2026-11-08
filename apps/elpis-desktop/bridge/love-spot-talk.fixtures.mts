import { createTestTempDir, removeTestTempDir } from "../tests/temp-root.cts";
import { type TestContext } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createLoveSpot } from "./love-spot-store.cts";
import { createLoveSpotTalk } from "./love-spot-talk.mts";
import { createMatildaCompanion } from "./matilda-companion.mts";

export const enabledAudio = { available: true };

export type ThreadRequest = {
  name: string;
  cwd: string;
  model: string;
  provider: string;
  permissions: string;
  instructions: string;
  automatic: boolean;
};

export type Attachment = { name: string; type: string; text: string; dataUrl: string };

export type Sent = {
  id: string;
  text: string;
  model: string;
  effort: string;
  automatic: boolean;
  pinned?: boolean;
  attachments: Attachment[];
};

export type Entry = { turnId: string; item: { id: string; type: string; text: string } };

export type MockClient = EventEmitter & {
  createThread: (value: ThreadRequest) => Promise<{ thread: { id: string } & Partial<ThreadRequest> }>;
  readThread: (
    id: string,
    options?: { cursor?: string },
  ) => Promise<{ thread: { id: string; name: string; cwd: string }; data: Entry[]; nextCursor: string | null }>;
  send: (id: string, value: Omit<Sent, "id">) => Promise<{ turn: { id: string } }>;
  voiceStatus: () => Promise<{ available: boolean; voice?: string }>;
  models: () => Promise<{ data: { model: string; inputModalities?: string[] }[]; nextCursor: null }>;
  interrupt: (id: string, body: { turnId: string }) => Promise<object>;
};

export type Talk = ReturnType<typeof createLoveSpotTalk>;

export type Update = Awaited<ReturnType<Talk["read"]>> & {
  heartReaction?: { threadId: string; itemId: string; portrait: string };
};

export type SpeechEvent = Parameters<Parameters<Awaited<ReturnType<Talk["speech"]>>["subscribe"]>[0]>[0];

export const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGM4o6SEFTEMLQkAvM5EAT6yk8sAAAAASUVORK5CYII=";

export const note = (id: string, text: string, color = "#e03131", extra = {}) => ({
  id,
  type: "text",
  text,
  strokeColor: color,
  version: 1,
  versionNonce: 1,
  x: 20,
  y: 30,
  width: 240,
  height: 40,
  updated: 1,
  ...extra,
});

export async function fixture(
  t: TestContext,
  { refuseFast = false, audio = enabledAudio, companion = false, standalone = false } = {},
) {
  const base = os.tmpdir();
  const directory = createTestTempDir(path.join(base, "love-talk-"));
  await fs.writeFile(
    path.join(directory, "scene.excalidraw"),
    JSON.stringify({ type: "excalidraw", version: 2, elements: [], files: {}, appState: {} }),
  );
  const store = createLoveSpot({ directory, screenshots: path.join(directory, "shots") });
  const client = new EventEmitter() as MockClient,
    created: ThreadRequest[] = [],
    sent: Sent[] = [],
    entries: Entry[] = [],
    speeds: { id: string; enabled: boolean }[] = [];
  Object.assign(client, {
    settings: async () => ({ main: { model: "luna", provider: "openai" } }),
    voiceStatus: async () => ({ available: true, voice: "juniper" }),
    models: async () => ({
      data: [
        { model: "luna", inputModalities: ["text", "image"] },
        { model: "text", inputModalities: ["text"] },
      ],
      nextCursor: null,
    }),
    createThread: async (value: ThreadRequest) => {
      created.push(value);
      return { thread: { id: "chat", ...value } };
    },
    readThread: async () => ({
      thread: { id: "chat", name: "Love Spot", cwd: directory },
      data: [...entries].reverse(),
      nextCursor: null,
    }),
    resume: async () => ({ activeTurnId: null }),
    send: async (id: string, value: Omit<Sent, "id">) => {
      sent.push({ id, ...value });
      return { turn: { id: `turn-${sent.length}` } };
    },
    setServiceTier: async (id: string, value: { enabled: boolean }) => {
      speeds.push({ id, ...value });
      if (refuseFast) throw Error("no Fast here");
      return { serviceTier: "priority" };
    },
  });
  const presence = companion
    ? createMatildaCompanion({
        store,
        env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: "unix:path=/nonexistent-matilda-test" },
      })
    : undefined;
  const talk = createLoveSpotTalk({
    client: client as unknown as Parameters<typeof createLoveSpotTalk>[0]["client"],
    store,
    audio,
    companion: presence,
    standalone,
  });
  t.after(async () => {
    talk.close();
    await store.close();
    removeTestTempDir(directory);
  });
  const finish = (id = "turn-1", status = "completed", reply = "Here with you.") =>
    client.emit("event", {
      type: "message",
      data: {
        method: "turn/completed",
        params: { threadId: "chat", turn: { id, status, items: [{ id: "reply", type: "agentMessage", text: reply }] } },
      },
    });
  return { directory, store, talk, client, created, sent, finish, entries, speeds, presence };
}

export const flower = [
  { type: "ellipse", x: 20, y: 0, width: 24, height: 24, strokeColor: "#e03131", backgroundColor: "#ffc9c9" },
  {
    type: "line",
    points: [
      [32, 24],
      [32, 80],
    ],
    strokeColor: "#2f9e44",
  },
  { type: "text", x: 0, y: 84, text: "for you" },
];

export const delta = (
  f: Awaited<ReturnType<typeof fixture>>,
  text: string,
  itemId = "reply",
  method = "item/agentMessage/delta",
) =>
  f.client.emit("event", {
    type: "message",
    data: { method, params: { threadId: "chat", turnId: `turn-${f.sent.length}`, itemId, delta: text } },
  });
