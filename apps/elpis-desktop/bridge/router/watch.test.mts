import { it } from "node:test";
import { expect } from "expect";
import type { Chat, ChatMessage } from "./chats.mts";
import { ChatWatch, LONG_LOOKS } from "./watch.mts";

/** A watch over chats the test changes between looks; it records every line said. */
function setup(skip: (chat: Pick<Chat, "id" | "folder">) => boolean = () => false) {
  let chats: Chat[] = [];
  const last = new Map<string, ChatMessage>();
  const said: string[] = [];
  const ids: string[] = [];
  const watch = new ChatWatch({
    chats: {
      list: () => Promise.resolve(chats),
      read: id =>
        id === "unreadable"
          ? Promise.reject(new Error("gone"))
          : Promise.resolve({
              chat: chats.find(chat => chat.id === id)!,
              messages: [last.get(id) ?? { from: "agent" as const, text: `Result of ${id}.\nMore detail below.` }],
            }),
    },
    skip,
    say: (id, text) => {
      ids.push(id);
      said.push(text);
      return Promise.resolve();
    },
  });
  const look = (next: Chat[]) => {
    chats = next;
    return watch.look();
  };
  /** The chat is seen working for long enough to be news. */
  const worksLong = async (id: string) => {
    for (let n = 0; n < LONG_LOOKS; n++) await look([chat(id, "working")]);
  };
  return { watch, look, worksLong, said, ids, last };
}
const chat = (id: string, state: Chat["state"], extra: Partial<Chat> = {}): Chat => ({
  id,
  title: `Chat ${id}`,
  state,
  ...extra,
});

it("says nothing at the first look, whatever the chats are doing", async () => {
  const { look, said } = setup();
  await look([chat("a", "working"), chat("b", "needs you"), chat("c", "idle")]);
  expect(said).toEqual([]);
});

it("says a long turn finished, with the first line of what the chat last said", async () => {
  const { look, worksLong, said } = setup();
  await look([]);
  await worksLong("a");
  await look([chat("a", "idle")]);
  expect(said).toEqual(["Finished: “Chat a”. Result of a."]);
});

it("stays quiet about a short turn in a chat he is using", async () => {
  const { look, said } = setup();
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:00.000Z" })]);
  await look([chat("a", "working")]);
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:09.000Z" })]);
  expect(said).toEqual([]);
});

it("announces the end of a turn the router started, even one that ended between two looks", async () => {
  const { watch, look, said } = setup();
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:00.000Z" })]);
  watch.expect("a");
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:04.000Z" })]);
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:04.000Z" })]);
  expect(said).toEqual(["Finished: “Chat a”. Result of a."]);
});

it("announces a chat the router started that is new to the list", async () => {
  const { watch, look, said } = setup();
  await look([]);
  watch.expect("new");
  await look([chat("new", "idle", { updated: "2026-11-10T20:00:04.000Z" })]);
  expect(said).toEqual(["Finished: “Chat new”. Result of new."]);
});

it("waits while the router's message is still the last word in the chat", async () => {
  const { watch, look, said, last } = setup();
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:00.000Z" })]);
  watch.expect("a");
  last.set("a", { from: "person", text: "also update the dashboard" });
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:02.000Z" })]);
  expect(said).toEqual([]);
  last.set("a", { from: "agent", text: "Dashboard updated." });
  await look([chat("a", "working", { updated: "2026-11-10T20:00:03.000Z" })]);
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:07.000Z" })]);
  expect(said).toEqual(["Finished: “Chat a”. Dashboard updated."]);
});

it("says a chat needs him once, not at every look while it waits", async () => {
  const { look, said } = setup();
  await look([chat("a", "working")]);
  await look([chat("a", "needs you")]);
  await look([chat("a", "needs you")]);
  expect(said).toEqual(["Needs you: “Chat a” is waiting for your approval or answer."]);
});

it("says a working chat failed", async () => {
  const { look, said } = setup();
  await look([chat("a", "working")]);
  await look([chat("a", "failed")]);
  expect(said).toEqual(["Failed: “Chat a” stopped with an error."]);
});

it("still names a long turn's chat when it cannot be read", async () => {
  const { look, worksLong, said } = setup();
  await look([]);
  await worksLong("unreadable");
  await look([chat("unreadable", "idle")]);
  expect(said).toEqual(["Finished: “Chat unreadable”."]);
});

it("never speaks about the router's own chats and workers", async () => {
  const worker = { folder: "/home/u/.elpis/router/work/t1" };
  const { look, said } = setup(item => item.folder === worker.folder);
  await look([]);
  for (let n = 0; n < LONG_LOOKS; n++) await look([chat("w", "working", worker)]);
  await look([chat("w", "idle", worker)]);
  expect(said).toEqual([]);
});

it("gives each change its own id, so a line repeated after a restart is not written twice", async () => {
  const { look, worksLong, ids } = setup();
  await look([]);
  await worksLong("a");
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:00.000Z" })]);
  await worksLong("a");
  await look([chat("a", "idle", { updated: "2026-11-10T21:00:00.000Z" })]);
  expect(new Set(ids).size).toBe(2);
});
