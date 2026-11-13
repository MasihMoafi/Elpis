import type { Page } from "playwright-core";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { fixture, CWD } = require("./parity-fixture.cts");

type Entry = { turnId: string; item: { id: string; type: string; content?: { type: string; text: string }[]; text?: string } };
const turn = (index: number): Entry[] => [
  { turnId: `t${index}`, item: { id: `u${index}`, type: "userMessage", content: [{ type: "text", text: `Request ${index}` }] } },
  { turnId: `t${index}`, item: { id: `a${index}`, type: "agentMessage", text: `Answer ${index}. ${"Conversation detail. ".repeat(20)}` } },
];

test("the router stays recent, loads older messages only on click, and preserves a reader's place", async () => {
  const saved = Array.from({ length: 25 }, (_, index) => turn(index)).flat();
  const thread = { id: "chat-a", name: "Elpis", motherAgent: true, cwd: CWD, status: { type: "idle" }, desktopAccess: { writable: true, mode: "direct", reason: null } };
  let reads = 0;
  const f = await fixture({
    staticDir: process.env.ELPIS_RENDERER_OUT,
    width: 1130, height: 750, colorScheme: "dark",
    threads: [thread, { ...thread, id: "chat-b", name: "Other chat", motherAgent: false }],
    storage: { "elpis-last-chat": "chat-a" },
    routes: { "/api/threads/chat-a": (_: unknown, url: URL) => {
      reads++;
      const start = Number(url.searchParams.get("cursor") ?? 0), end = start + 100;
      return { thread, data: [...saved].reverse().slice(start, end), nextCursor: end < saved.length ? String(end) : null };
    } },
  });
  const page: Page = f.page;
  const users = () => page.locator(".chat-content .message.user").count();
  const top = () => page.locator(".chat-scroll").evaluate(element => { element.scrollTop = 0; });
  const arrive = async (index: number) => {
    const entries = turn(index);
    saved.push(...entries);
    for (const entry of entries) f.emit("message", { method: "item/completed", params: { threadId: thread.id, ...entry } });
    await page.locator(".chat-content").getByText(`Request ${index}`, { exact: true }).waitFor();
  };
  try {
    await page.locator(".chat-content").getByText("Request 24", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    await top();
    if (process.env.ELPIS_ROUTER_HISTORY_SHOTS) {
      await fs.mkdir(process.env.ELPIS_ROUTER_HISTORY_SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(process.env.ELPIS_ROUTER_HISTORY_SHOTS, "router-history.png") });
    }
    assert.equal(await users(), 10, "opening the router releases older entries");
    const readCount = reads;
    await page.waitForTimeout(400);
    assert.equal(reads, readCount, "scrolling to the top does not fetch older messages");
    const anchor = page.locator(".chat-content").getByText("Request 15", { exact: true });
    const offset = await anchor.evaluate(element => element.getBoundingClientRect().top);
    await page.getByRole("button", { name: "Load more messages", exact: true }).click();
    await page.locator(".chat-content").getByText("Request 5", { exact: true }).waitFor();
    assert.equal(await users(), 20, "a click adds ten requests");
    await page.waitForTimeout(1100);
    assert.ok(Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - offset) < 2, "the visible message stays in place");
    await arrive(25);
    assert.equal(await users(), 21, "a reader's loaded history stays visible during incoming replies");
    await page.locator(".chat-scroll").evaluate(element => { element.scrollTop = element.scrollHeight; });
    await page.waitForTimeout(300);
    await arrive(26);
    await page.waitForFunction(() => document.querySelectorAll(".chat-content .message.user").length === 10);
    await f.open("chat-b");
    await page.locator('.thread-row[data-thread-id="chat-a"] .thread-link').click();
    await page.locator(".chat-content").getByText("Request 26", { exact: true }).waitFor();
    assert.equal(await users(), 10, "returning to the router restores only recent history");
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});
