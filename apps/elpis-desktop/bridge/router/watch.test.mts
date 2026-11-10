import { it } from "node:test";
import { expect } from "expect";
import type { Chat } from "./chats.mts";
import { ChatWatch } from "./watch.mts";

/** A watch over chats the test changes between looks; it records every line said. */
function setup(skip: (chat: Pick<Chat, "id" | "folder">) => boolean = () => false) {
  let chats: Chat[] = [];
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
              messages: [{ from: "agent" as const, text: `Result of ${id}.\nMore detail below.` }],
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
  return { look, said, ids };
}
const chat = (id: string, state: Chat["state"], extra: Partial<Chat> = {}): Chat => ({ id, title: `Chat ${id}`, state, ...extra });

it("says nothing at the first look, whatever the chats are doing", async () => {
  const { look, said } = setup();
  await look([chat("a", "working"), chat("b", "needs you"), chat("c", "idle")]);
  expect(said).toEqual([]);
});

it("says a chat finished, with the first line of what it last said", async () => {
  const { look, said } = setup();
  await look([chat("a", "working")]);
  await look([chat("a", "idle")]);
  expect(said).toEqual(["Finished: “Chat a”. Result of a."]);
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

it("stays quiet about a chat that was idle, and about one it cannot read it still names", async () => {
  const { look, said } = setup();
  await look([chat("a", "idle"), chat("unreadable", "working")]);
  await look([chat("a", "idle"), chat("unreadable", "idle")]);
  expect(said).toEqual(["Finished: “Chat unreadable”."]);
});

it("never speaks about the router's own chats and workers", async () => {
  const { look, said } = setup(item => item.folder === "/home/u/.elpis/router/work/t1");
  await look([chat("w", "working", { folder: "/home/u/.elpis/router/work/t1" })]);
  await look([chat("w", "idle", { folder: "/home/u/.elpis/router/work/t1" })]);
  expect(said).toEqual([]);
});

it("gives each change its own id, so a line repeated after a restart is not written twice", async () => {
  const { look, ids } = setup();
  await look([chat("a", "working")]);
  await look([chat("a", "idle", { updated: "2026-11-10T20:00:00.000Z" })]);
  await look([chat("a", "working")]);
  await look([chat("a", "idle", { updated: "2026-11-10T21:00:00.000Z" })]);
  expect(new Set(ids).size).toBe(2);
});
