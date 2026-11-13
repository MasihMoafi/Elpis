import { after, test } from "node:test";
import assert from "node:assert/strict";
import { act, createElement, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { dom } from "../components/mother/fixtures/dom.mts";
import type { Entry } from "../lib/api.ts";
import { readEarlierHistory, recentRouterHistory } from "../lib/router-history.mts";

const { useTranscriptHistory } = await import("../lib/use-transcript-history.ts");

after(() => dom.window.close());
const turns = (count: number): Entry[] => Array.from({ length: count }, (_, index) => [
  { turnId: `t${index}`, item: { id: `u${index}`, type: "userMessage", content: [{ type: "text", text: `Request ${index}` }] } },
  { turnId: `t${index}`, item: { id: `a${index}`, type: "agentMessage", text: `Answer ${index}` } },
]).flat();

async function mounted(motherAgent: boolean) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let state: {
    entries: Entry[];
    history: ReturnType<typeof useTranscriptHistory>;
    append: (entries: Entry[]) => void;
    prepend: (entries: Entry[]) => void;
    bottom: { current: boolean };
  };
  function Chat() {
    const [entries, setEntries] = useState(turns(12));
    const bottom = useRef(true);
    const history = useTranscriptHistory({ id: "chat", motherAgent }, false, entries, setEntries, bottom);
    state = {
      entries, history, bottom,
      append: extra => setEntries(previous => [...previous, ...extra]),
      prepend: extra => setEntries(previous => [...extra, ...previous]),
    };
    return null;
  }
  await act(async () => root.render(createElement(Chat)));
  return {
    get state() { return state!; },
    async close() { await act(async () => root.unmount()); host.remove(); },
  };
}

test("the router releases old entries and cache as live requests arrive", async t => {
  const chat = await mounted(true);
  t.after(chat.close);
  assert.equal(chat.state.entries.length, 20, "only the latest ten requests open");
  assert.equal(chat.state.entries[0]?.item.id, "u2");
  chat.state.history.heldEarlier.current.set("chat", turns(2));
  for (const entry of turns(13)) chat.state.history.liveVersions.current.set(`${entry.turnId}:${entry.item.id}`, 1);
  await act(async () => chat.state.append(turns(13).slice(-2)));
  assert.equal(chat.state.entries[0]?.item.id, "u3");
  assert.equal(chat.state.entries.length, 20);
  assert.equal(chat.state.history.transcripts.current.get("chat")?.entries.length, 20);
  assert.ok(chat.state.history.itemCursor, "released history remains loadable");
  assert.equal(chat.state.history.heldEarlier.current.has("chat"), false);
  assert.equal(chat.state.history.liveVersions.current.size, 20, "released live versions do not accumulate");
});

test("reading older history keeps the view while only recent history stays cached", async t => {
  const chat = await mounted(true);
  t.after(chat.close);
  chat.state.bottom.current = false;
  await act(async () => chat.state.prepend(turns(2)));
  await act(async () => chat.state.append(turns(13).slice(-2)));
  assert.equal(chat.state.entries.length, 26, "incoming replies do not remove history being read");
  assert.equal(chat.state.entries[0]?.item.id, "u0");
  assert.equal(chat.state.history.transcripts.current.get("chat")?.entries[0]?.item.id, "u3");
  chat.state.bottom.current = true;
  await act(async () => chat.state.append(turns(14).slice(-2)));
  assert.equal(chat.state.entries.length, 20, "following new replies resumes trimming");
});

test("ordinary chats retain their loaded history", async t => {
  const chat = await mounted(false);
  t.after(chat.close);
  assert.equal(chat.state.entries.length, 24);
  await act(async () => chat.state.append(turns(13).slice(-2)));
  assert.equal(chat.state.entries.length, 26);
});

test("released history is read before its stable boundary despite new messages and multiple pages", async () => {
  const recent = recentRouterHistory(turns(12), "old-page");
  assert.ok(recent.cursor);
  const saved = turns(35).reverse(), reads: (string | undefined)[] = [];
  const page = await readEarlierHistory(recent.cursor, async cursor => {
    reads.push(cursor);
    const offset = Number(cursor ?? 0), end = offset + 8;
    return { data: saved.slice(offset, end), nextCursor: end < saved.length ? String(end) : null };
  });
  assert.ok(reads.length > 1);
  assert.deepEqual(page.data, turns(2).reverse());
  assert.equal(page.nextCursor, null);
});

test("worker notices are bounded even without new requests", () => {
  const history = Array.from({ length: 150 }, (_, index) => ({ turnId: `notice${index}`, item: { id: "answer", type: "agentMessage", text: `Result ${index}` } }));
  const recent = recentRouterHistory(history, null);
  assert.equal(recent.entries.length, 100);
  assert.equal(recent.entries[0]?.turnId, "notice50");
});

test("opaque cursors pass through and unavailable or repeating boundaries fail without duplicating history", async () => {
  const page = { data: turns(2).reverse(), nextCursor: null };
  assert.equal(await readEarlierHistory("opaque", async cursor => { assert.equal(cursor, "opaque"); return page; }), page);
  const recent = recentRouterHistory(turns(12), null);
  assert.ok(recent.cursor);
  await assert.rejects(readEarlierHistory(recent.cursor, async () => page), /Refresh this conversation/);
  await assert.rejects(readEarlierHistory(recent.cursor, async () => ({ data: [], nextCursor: "same" })), /Repeated conversation cursor/);
});
