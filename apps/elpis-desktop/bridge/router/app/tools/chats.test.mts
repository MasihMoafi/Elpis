import { it } from "node:test";
import { expect } from "expect";
import type { Chat, Chats } from "../../chats.mts";
import { chatTools, chatToolsHost } from "./chats.mts";

const ROUTER = { home: "/home/u/.elpis", threadId: "elpis" };
const CHATS: Chat[] = [
  { id: "idle-new", title: "Check email", state: "idle", updated: "2026-11-10T20:00:00.000Z" },
  { id: "elpis", title: "Elpis", state: "idle" },
  { id: "working", title: "Review scraper", state: "working", folder: "/work/legal" },
  { id: "session", title: "Router session", state: "working", folder: "/home/u/.elpis/router" },
  { id: "waiting", title: "Deploy site", state: "needs you" },
  { id: "idle-old", title: "Old notes", state: "idle", updated: "2026-11-01T08:00:00.000Z" },
  { id: "worker", title: "Count lines", state: "idle", folder: "/home/u/.elpis/router/work/count-lines-1" },
];

/** The tools over fixed chats, recording every action taken on them. */
function setup(sources: Record<string, { enabled: boolean }> = { "elpis-chat": { enabled: true } }) {
  const actions: unknown[][] = [];
  const act =
    (name: string) =>
    (...args: unknown[]) => {
      actions.push([name, ...args]);
      return Promise.resolve();
    };
  const chats: Chats = {
    list: ({ cursor }) => Promise.resolve(cursor ? { chats: [] } : { chats: CHATS, next: "more" }),
    read: (id, limit) => {
      const chat = CHATS.find(item => item.id === id);
      if (!chat) return Promise.reject(new Error("No such chat"));
      return Promise.resolve({
        chat,
        messages: [{ from: "agent" as const, text: "x".repeat(2500) }].slice(0, limit),
      });
    },
    send: act("send"),
    start: input => {
      actions.push(["start", input]);
      return Promise.resolve({ id: "new", title: input.name ?? "New", state: "working" as const });
    },
    stop: act("stop"),
    rename: act("rename"),
    archive: act("archive"),
    restore: act("restore"),
  };
  const tools = new Map(chatTools(chatToolsHost(chats, ROUTER, () => ({ sources }))).map(tool => [tool.name, tool]));
  const run = (name: string, args: unknown) => tools.get(name)!.execute(args, new AbortController().signal);
  return { run, actions };
}

it("lists what needs him first, then what works, then the newest, and leaves out the router's own chats", async () => {
  const { run } = setup();
  const listed = (await run("chats_list", {})) as { needs_you: number; working: number; chats: Chat[] };
  expect(listed.chats.map(chat => chat.id)).toEqual(["waiting", "working", "idle-new", "idle-old", "worker"]);
  expect({ needs_you: listed.needs_you, working: listed.working }).toEqual({ needs_you: 1, working: 1 });
});

it("reads a chat and cuts a very long message, saying how much is left", async () => {
  const { run } = setup();
  const read = (await run("chats_read", { chat: "working" })) as { messages: { text: string }[] };
  expect(read.messages[0]!.text).toMatch(/^x{2000}… \(500 more characters\)$/);
});

it("writes in the chat he named and says which one", async () => {
  const { run, actions } = setup();
  expect(await run("chats_send", { chat: "working", text: " also update the dashboard " })).toEqual({
    sent: true,
    chat: "Review scraper",
  });
  expect(actions).toEqual([["send", "working", "also update the dashboard"]]);
});

it("may write in a worker's chat, which is an ordinary chat", async () => {
  const { run, actions } = setup();
  await run("chats_send", { chat: "worker", text: "status?" });
  expect(actions).toEqual([["send", "worker", "status?"]]);
});

it("never acts on its own conversation or its own Sessions", async () => {
  const { run, actions } = setup();
  for (const chat of ["elpis", "session"]) {
    await expect(run("chats_send", { chat, text: "hi" })).rejects.toThrow("router's own chat");
    await expect(run("chats_change", { chat, action: "archive" })).rejects.toThrow("router's own chat");
  }
  expect(actions).toEqual([]);
});

it("does nothing to his chats while a Source that carries outside text is on", async () => {
  const { run, actions } = setup({ "elpis-chat": { enabled: true }, github: { enabled: true } });
  for (const [name, args] of [
    ["chats_list", {}],
    ["chats_read", { chat: "working" }],
    ["chats_send", { chat: "working", text: "hi" }],
    ["chats_start", { text: "hi" }],
    ["chats_change", { chat: "working", action: "stop" }],
  ] as const)
    await expect(run(name, args)).rejects.toThrow("outside text");
  expect(actions).toEqual([]);
});

it("starts a new chat with his first message, folder and model", async () => {
  const { run, actions } = setup();
  const started = await run("chats_start", { text: "say hi", name: "Hello", folder: "/work/legal", model: "gpt-6-luna" });
  expect(started).toEqual({ started: true, chat: { id: "new", title: "Hello", state: "working" } });
  expect(actions).toEqual([["start", { text: "say hi", name: "Hello", folder: "/work/legal", model: "gpt-6-luna" }]]);
});

it("refuses a folder that is not an absolute path", async () => {
  const { run } = setup();
  await expect(run("chats_start", { text: "hi", folder: "legal" })).rejects.toThrow();
});

it("stops, renames, archives and restores the chat he named; a rename needs the new title", async () => {
  const { run, actions } = setup();
  expect(await run("chats_change", { chat: "working", action: "stop" })).toEqual({ stopped: true, chat: "Review scraper" });
  expect(await run("chats_change", { chat: "working", action: "rename", name: "Scraper" })).toEqual({
    renamed: true,
    from: "Review scraper",
    to: "Scraper",
  });
  expect(await run("chats_change", { chat: "idle-old", action: "archive" })).toEqual({ archived: true, chat: "Old notes" });
  expect(await run("chats_change", { chat: "idle-old", action: "restore" })).toEqual({ restored: true, chat: "Old notes" });
  await expect(run("chats_change", { chat: "working", action: "rename" })).rejects.toThrow("rename needs name");
  expect(actions).toEqual([
    ["stop", "working"],
    ["rename", "working", "Scraper"],
    ["archive", "idle-old"],
    ["restore", "idle-old"],
  ]);
});

it("offers no way to delete a chat", () => {
  expect(chatTools(chatToolsHost({} as Chats, ROUTER, () => ({ sources: {} }))).map(tool => tool.name)).toEqual([
    "chats_list",
    "chats_read",
    "chats_send",
    "chats_start",
    "chats_change",
  ]);
});

it("hands on the cursor to the next page until there is none", async () => {
  const { run } = setup();
  const first = (await run("chats_list", { limit: 50 })) as { next_cursor?: string; chats: Chat[] };
  expect(first.next_cursor).toBe("more");
  const second = (await run("chats_list", { limit: 50, cursor: "more" })) as { next_cursor?: string; chats: Chat[] };
  expect(second).toEqual({ needs_you: 0, working: 0, failed: 0, chats: [] });
});

it("archives many chats in one call, names the ones it may not touch, and still does the rest", async () => {
  const { run, actions } = setup();
  const result = await run("chats_change", { chats: ["idle-old", "elpis", "missing", "idle-new", "idle-old"], action: "archive" });
  expect(result).toEqual({
    archived: 2,
    chats: ["Old notes", "Check email"],
    refused: [
      { chat: "elpis", why: "This is the router's own chat; it does not act on itself" },
      { chat: "missing", why: "No such chat" },
    ],
  });
  expect(actions).toEqual([
    ["archive", "idle-old"],
    ["archive", "idle-new"],
  ]);
});

it("restores many chats in one call, and takes one chat at a time for stop and rename", async () => {
  const { run, actions } = setup();
  expect(await run("chats_change", { chats: ["idle-old"], action: "restore" })).toEqual({
    restored: 1,
    chats: ["Old notes"],
    refused: [],
  });
  await expect(run("chats_change", { chats: ["working"], action: "stop" })).rejects.toThrow("one chat at a time");
  await expect(run("chats_change", { chat: "working", chats: ["working"], action: "archive" })).rejects.toThrow("not both");
  await expect(run("chats_change", { action: "archive" })).rejects.toThrow("Give chat");
  expect(actions).toEqual([["restore", "idle-old"]]);
});
