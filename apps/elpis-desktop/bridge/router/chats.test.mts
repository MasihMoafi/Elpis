import { it } from "node:test";
import { expect } from "expect";
import { chatState, createChats, type ChatsClient } from "./chats.mts";

/** A desktop client that records what the router asked of it and answers from fixed chats. */
function client(overrides: Partial<ChatsClient> = {}) {
  const calls: [string, ...unknown[]][] = [];
  const record =
    (name: string, result: unknown = {}) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve(result);
    };
  const fake: ChatsClient = {
    listThreads: record("listThreads", {
      data: [
        { id: "a", name: "Fix the scraper", cwd: "/work/legal", model: "gpt-6-luna", updatedAt: 1_794_000_000, status: { type: "idle" } },
        { id: "b", name: null, preview: "count the lines\nof main.rs", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
      ],
    }),
    listArchivedThreads: record("listArchivedThreads", { data: [{ id: "z", name: "Old plan" }] }),
    readThread: record("readThread", {
      thread: { id: "a", name: "Fix the scraper", status: { type: "active" } },
      data: [
        { turnId: "t2", startedAtMs: 1_794_000_060_000, item: { id: "2", type: "agentMessage", text: "Done: 3 files." } },
        { turnId: "t2", item: { id: "x", type: "commandExecution", text: "ls" } },
        { turnId: "t1", item: { id: "1", type: "userMessage", content: [{ type: "text", text: "Fix it" }, { type: "image", url: "u" }] } },
      ],
    }),
    createThread: record("createThread", { thread: { id: "new" } }),
    send: record("send"),
    interrupt: record("interrupt"),
    renameThread: record("renameThread"),
    archiveThread: record("archiveThread"),
    unarchiveThread: record("unarchiveThread"),
    ...overrides,
  };
  return { fake, calls };
}

it("reads a chat's state as the sidebar shows it: waiting for him counts before working", () => {
  expect(chatState({ type: "active", activeFlags: ["waitingOnUserInput"] })).toBe("needs you");
  expect(chatState({ type: "active", activeFlags: [] })).toBe("working");
  expect(chatState({ type: "systemError" })).toBe("failed");
  expect(chatState({ type: "notLoaded" })).toBe("idle");
  expect(chatState(undefined)).toBe("idle");
});

it("lists chats with a title, a state and where they work; an unnamed chat takes its first line", async () => {
  const { fake, calls } = client();
  const { chats, next } = await createChats(fake).list({ search: "scraper", limit: 5 });
  expect(calls).toEqual([["listThreads", { limit: 5, searchTerm: "scraper" }]]);
  expect(next).toBeUndefined();
  expect(chats).toEqual([
    { id: "a", title: "Fix the scraper", state: "idle", folder: "/work/legal", model: "gpt-6-luna", updated: "2026-11-06T21:20:00.000Z" },
    { id: "b", title: "count the lines", state: "needs you" },
  ]);
});

it("lists the archive from the archive, and marks every chat there archived", async () => {
  const { fake, calls } = client();
  expect(await createChats(fake).list({ archived: true, limit: 3 })).toEqual({
    chats: [{ id: "z", title: "Old plan", state: "idle", archived: true }],
  });
  expect(calls).toEqual([["listArchivedThreads", { limit: 3 }]]);
});

it("reads a chat oldest first, keeping what he said and what the agent answered, without tool steps", async () => {
  const { fake } = client();
  const read = await createChats(fake).read("a", 6);
  expect(read.chat).toEqual({ id: "a", title: "Fix the scraper", state: "working" });
  expect(read.messages).toEqual([
    { from: "person", text: "Fix it" },
    { from: "agent", text: "Done: 3 files.", at: "2026-11-06T21:21:00.000Z" },
  ]);
});

it("starts a chat by creating it in the folder, then sending the first message with its thinking level", async () => {
  const { fake, calls } = client();
  await createChats(fake).start({ text: "say hi", name: "Hello", folder: "/work/legal", model: "gpt-6-luna", effort: "low" });
  expect(calls.slice(0, 2)).toEqual([
    ["createThread", { cwd: "/work/legal", model: "gpt-6-luna", name: "Hello" }],
    ["send", "new", { text: "say hi", effort: "low" }],
  ]);
});

it("sends, stops, renames, archives and restores through the same client actions the window uses", async () => {
  const { fake, calls } = client();
  const chats = createChats(fake);
  await chats.send("a", "also update the dashboard");
  await chats.stop("a");
  await chats.rename("a", "Scraper");
  await chats.archive("a");
  await chats.restore("a");
  expect(calls).toEqual([
    ["send", "a", { text: "also update the dashboard" }],
    ["interrupt", "a", {}],
    ["renameThread", "a", { name: "Scraper" }],
    ["archiveThread", "a", {}],
    ["unarchiveThread", "a", {}],
  ]);
});

it("passes a refused action on as the client said it", async () => {
  const { fake } = client({ interrupt: () => Promise.reject(new Error("This agent is not running")) });
  await expect(createChats(fake).stop("a")).rejects.toThrow("This agent is not running");
});

it("reads his chats page after page: the cursor of one page asks for the next", async () => {
  const { fake, calls } = client({
    listThreads: (options: { cursor?: string }) =>
      Promise.resolve(
        options.cursor === "p2"
          ? { data: [{ id: "c", name: "Third" }], nextCursor: null }
          : { data: [{ id: "a", name: "First" }], nextCursor: "p2" },
      ),
  });
  const chats = createChats(fake);
  const first = await chats.list({ limit: 1 });
  expect(first.next).toBe("p2");
  const second = await chats.list({ limit: 1, cursor: first.next });
  expect(second).toEqual({ chats: [{ id: "c", title: "Third", state: "idle" }] });
  expect(calls).toEqual([]);
});

it("reads on past pages of tool steps until it has the messages asked for", async () => {
  const step = (id: string) => ({ turnId: "t", item: { id, type: "commandExecution", text: "ls" } });
  const pages: Record<string, unknown> = {
    first: { thread: { id: "a", name: "Busy" }, data: [step("3"), step("2")], nextCursor: "older" },
    older: {
      thread: { id: "a", name: "Busy" },
      data: [step("1"), { turnId: "t", item: { id: "0", type: "agentMessage", text: "Started." } }],
      nextCursor: null,
    },
  };
  const { fake } = client({ readThread: (_id: string, options: { cursor?: string }) => Promise.resolve(pages[options.cursor ?? "first"]) });
  const read = await createChats(fake).read("a", 1);
  expect(read.messages).toEqual([{ from: "agent", text: "Started." }]);
});

it("narrows the archive by the words searched for, since the archive has no search of its own", async () => {
  const { fake } = client({
    listArchivedThreads: () => Promise.resolve({ data: [{ id: "x", name: "Billing export" }, { id: "y", name: "Holiday plan" }] }),
  });
  const { chats } = await createChats(fake).list({ archived: true, search: "billing", limit: 50 });
  expect(chats.map(chat => chat.id)).toEqual(["x"]);
});

it("marks a chat archived when the desktop says so either way", async () => {
  const { fake } = client({ readThread: () => Promise.resolve({ thread: { id: "a", name: "Old", archived: true }, data: [] }) });
  expect((await createChats(fake).read("a", 1)).chat.archived).toBe(true);
});

it("leaves no empty chat behind when the first message is refused, and reads nothing after a good start", async () => {
  const refused = client({ send: () => Promise.reject(new Error("Unknown model")) });
  await expect(createChats(refused.fake).start({ text: "hi", name: "Hello" })).rejects.toThrow("Unknown model");
  expect(refused.calls.at(-1)).toEqual(["archiveThread", "new", {}]);
  const started = client();
  const chat = await createChats(started.fake).start({ text: "say hi\nplease", folder: "/work/legal" });
  expect(chat).toEqual({ id: "new", title: "say hi", state: "working", folder: "/work/legal" });
  expect(started.calls.map(call => call[0])).toEqual(["createThread", "send"]);
});
