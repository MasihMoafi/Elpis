import type { Page } from "playwright-core";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fixture, CWD } = require("./parity-fixture.cts");
const { scrollToLoadEarlier } = require("./controls.cts");

// 13 Nov, Masih: "the main router chat ... should clear it up itself basically so it's not a load on the screen nor on
// the cache? and if I want to see older conversation I'd have to click the load more messages button on top".
type Entry = { turnId: string; item: { id: string; type: string; content?: { type: string; text: string }[]; text?: string } };
const turn = (index: number, label = "Request"): Entry[] => [
  { turnId: `t${index}`, item: { id: `u${index}`, type: "userMessage", content: [{ type: "text", text: `${label} ${index}` }] } },
  { turnId: `t${index}`, item: { id: `a${index}`, type: "agentMessage", text: `Answer ${index}. ${"Conversation detail. ".repeat(20)}` } },
];
/** The bridge's prompt index: every request, oldest first. */
const index = (saved: Entry[]) => saved.filter(entry => entry.item.type === "userMessage")
  .map(entry => ({ turnId: entry.turnId, itemId: entry.item.id, text: entry.item.content?.[0]?.text ?? "" }));
/** The bridge's history read: newest first, `size` entries a page, the offset as cursor. */
const paged = (thread: object, saved: Entry[], size: number) => (url: URL) => {
  const start = Number(url.searchParams.get("cursor") ?? 0), end = start + size;
  return { thread, data: [...saved].reverse().slice(start, end), nextCursor: end < saved.length ? String(end) : null };
};

test("the router stays recent, loads older messages only on click, and preserves a reader's place", async () => {
  const saved = Array.from({ length: 25 }, (_, index) => turn(index)).flat();
  const plain = Array.from({ length: 25 }, (_, index) => turn(index, "Plain")).flat();
  const base = { cwd: CWD, status: { type: "idle" }, desktopAccess: { writable: true, mode: "direct", reason: null } };
  const thread = { ...base, id: "elpis", name: "Elpis", motherAgent: true };
  const other = { ...base, id: "chat-b", name: "Other chat" };
  let reads = 0, plainReads = 0;
  const f = await fixture({
    staticDir: process.env.ELPIS_RENDERER_OUT,
    width: 1130, height: 750, colorScheme: "dark",
    threads: [thread, other], readyThreadId: "chat-b",
    routes: {
      "/api/threads/elpis": (_: unknown, url: URL) => { reads++; return paged(thread, saved, 100)(url); },
      // An ordinary chat, a page of ten requests at a time: the negative case, it keeps loading on scroll.
      "/api/threads/chat-b": (_: unknown, url: URL) => { plainReads++; return paged(other, plain, 20)(url); },
      // The bridge indexes every request of a chat, shown or not.
      "/api/threads/elpis/prompts": () => ({ data: index(saved) }),
      "/api/threads/chat-b/prompts": () => ({ data: index(plain) }),
    },
  });
  const page: Page = f.page;
  const users = () => page.locator(".chat-content .message.user").count();
  // F2 (14 Nov): the rail listed 37 requests while ten were on screen.
  const marks = () => page.getByRole("button", { name: /^Jump to user message \d+$/ }).count();
  const top = () => page.locator(".chat-scroll").evaluate(element => { element.scrollTop = 0; });
  const button = page.getByRole("button", { name: "Load more messages", exact: true });
  const openElpis = () => page.locator('aside.sidebar nav[aria-label="Workspace"]').getByRole("button", { name: "Elpis", exact: true }).click();
  const arrive = async (index: number) => {
    const entries = turn(index);
    saved.push(...entries);
    for (const entry of entries) f.emit("message", { method: "item/completed", params: { threadId: thread.id, ...entry } });
    await page.locator(".chat-content").getByText(`Request ${index}`, { exact: true }).waitFor();
  };
  try {
    await openElpis();
    await page.locator(".chat-content").getByText("Request 24", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await top();
    assert.equal(await users(), 10, "opening the router shows its latest ten requests");
    assert.equal(await marks(), 10, "the rail lists only the requests on screen");
    const readCount = reads;
    await page.waitForTimeout(400);
    if (process.env.ELPIS_ROUTER_HISTORY_SHOTS) {
      await fs.mkdir(process.env.ELPIS_ROUTER_HISTORY_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ELPIS_ROUTER_HISTORY_SHOTS, "router-history.png") });
    }
    assert.equal(reads, readCount, "scrolling to the top does not fetch older messages");
    assert.equal(await users(), 10, "scrolling to the top adds no messages");
    const anchor = page.locator(".chat-content").getByText("Request 15", { exact: true });
    const offset = await anchor.evaluate(element => element.getBoundingClientRect().top);
    await button.click();
    await page.locator(".chat-content").getByText("Request 5", { exact: true }).waitFor();
    assert.equal(await users(), 20, "a click adds ten requests");
    await page.waitForFunction(() => document.querySelectorAll('[aria-label^="Jump to user message"]').length === 20);
    await page.waitForTimeout(1100);
    assert.ok(Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - offset) < 2, "the visible message stays in place");
    const reading = await anchor.evaluate(element => element.getBoundingClientRect().top);
    await arrive(25);
    assert.equal(await users(), 21, "a reader's loaded history stays visible during incoming replies");
    assert.ok(Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - reading) < 2, "a reply does not move his place");
    await page.locator(".chat-scroll").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(300);
    await arrive(26);
    await page.waitForFunction(() => document.querySelectorAll(".chat-content .message.user").length === 10);

    await f.open("chat-b");
    await page.locator(".chat-content").getByText("Plain 24", { exact: true }).waitFor();
    assert.equal(await users(), 10, "the ordinary chat opens with its first page");
    const plainBefore = plainReads;
    await scrollToLoadEarlier(page);
    await page.locator(".chat-content").getByText("Plain 14", { exact: true }).waitFor();
    assert.ok(plainReads > plainBefore, "scrolling to the top of an ordinary chat reads older messages");
    assert.ok(await users() >= 20, "an ordinary chat keeps loading on scroll");
    assert.equal(await button.count(), 0, "an ordinary chat has no Load more button");
    assert.equal(await marks(), 25, "an ordinary chat's rail still lists every request and loads older ones on a jump");

    await openElpis();
    await page.locator(".chat-content").getByText("Request 26", { exact: true }).waitFor();
    assert.equal(await users(), 10, "returning to the router restores only recent history");
    assert.equal(await button.count(), 1, "older router messages are one click away");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
