// The context split Elpis draws for a bridged chat (/context, the Context Ledger, the dashboard).
// Elpis requires its parts to add up to the reported context; a debug build panicked when the
// text-length estimates exceeded what Antigravity reported (4379 vs 3210).
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitContext, splitTokens, transcriptTokens } from "../context-split.mjs";

const total = (split) => Object.entries(split).filter(([k]) => k !== "estimatedTotal").reduce((sum, [, v]) => sum + v, 0);

test("estimates larger than the reported context shrink to fit it", () => {
  const split = splitContext({ user: 9000, agent: 4000, reasoning: 0, toolCalls: 2000, toolResults: 2516 }, 0, 3210);
  assert.equal(split.estimatedTotal, 3210);
  assert.equal(total(split), 3210);
  assert.equal(split.systemInstructions, 0);
  assert.ok(split.userMessages > split.agentMessages, "proportions are kept");
});

test("the rest of a larger reported context is the system instructions", () => {
  const split = splitContext({ user: 400, agent: 800, reasoning: 0, toolCalls: 0, toolResults: 0 }, 2000, 5000);
  assert.deepEqual([split.userMessages, split.agentMessages, split.developerMessages], [100, 200, 500]);
  assert.equal(split.systemInstructions, 4200);
  assert.equal(total(split), 5000);
});

// A Claude chat's parts come from Claude's own token counts in its transcript: each request's
// growth is the inputs added since the one before (its user message or tool results) plus the
// reply before it; a reply's tokens its text and tool calls do not explain are its hidden thinking.
// Claude Code's own additions, and the system prompt the first request carries, are system.
test("a transcript's parts follow Claude's token counts since its last compaction", () => {
  const line = (d) => JSON.stringify(d);
  const ask = (id, total, out, content) => line({ type: "assistant", message: { id, usage: { input_tokens: 2, cache_read_input_tokens: total - 2, cache_creation_input_tokens: 0, output_tokens: out }, content } });
  const jsonl = [
    line({ type: "user", message: { content: "x".repeat(4000) } }),
    line({ type: "system", subtype: "compact_boundary" }),
    line({ type: "attachment", attachment: { type: "skill_listing", content: "s".repeat(400) } }),
    line({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["p"] } }),
    line({ type: "user", message: { content: "u".repeat(400) } }),
    // First request: 10,000 in; the user message is ~100 of it, the rest is system.
    ask("m1", 10000, 900, [{ type: "thinking", thinking: "", signature: "sig" }]),
    ask("m1", 10000, 900, [{ type: "tool_use", input: { c: "y".repeat(1990) } }]),
    line({ type: "user", message: { content: [{ type: "tool_result", content: "r".repeat(3000) }] } }),
    // Claude Code saves its prompt before each request, the first without its tools; one that
    // changes nothing it knew is not a new prompt.
    line({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["p"], tools: [{ name: "Bash" }] } }),
    // Second request: grew by 3,400 = the 900 reply + 2,500 of tool result.
    ask("m2", 13400, 50, [{ type: "text", text: "t".repeat(200) }]),
    line({ type: "user", isSidechain: true, message: { content: "a subagent's own prompt" } }),
    "not json",
  ].join("\n");
  const t = transcriptTokens(jsonl);
  assert.equal(t.user, 100);
  assert.equal(t.toolResults, 2500);
  assert.equal(t.toolCalls, 500);
  assert.equal(t.reasoning, 400);
  assert.equal(t.agent, 50);
  assert.equal(t.system, 9900);
  assert.equal(t.user + t.toolResults + t.toolCalls + t.reasoning + t.agent + t.system, 13400 + 50);
});

test("the token parts fit the reported context, the rest being system instructions", () => {
  const split = splitTokens({ developerMessages: 500, userMessages: 100, agentMessages: 50, reasoning: 400, toolCalls: 500, toolResults: 2500 }, 13450);
  assert.equal(split.systemInstructions, 9400);
  assert.equal(total(split), 13450);
});

test("a request after a changed system prompt carries it as system", () => {
  const line = (d) => JSON.stringify(d);
  const ask = (id, total) => line({ type: "assistant", message: { id, usage: { input_tokens: total, output_tokens: 0 }, content: [{ type: "text", text: "" }] } });
  const snap = (p) => line({ type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: [p] } });
  const said = line({ type: "user", message: { content: "u".repeat(400) } });
  // Same prompt: the growth is the message. A new prompt (settings reloaded): the growth is system.
  const same = transcriptTokens([snap("a"), said, ask("m1", 1000), snap("a"), said, ask("m2", 1300)].join("\n"));
  const changed = transcriptTokens([snap("a"), said, ask("m1", 1000), snap("b"), said, ask("m2", 1300)].join("\n"));
  assert.deepEqual([same.user, same.system], [400, 900]);
  assert.deepEqual([changed.user, changed.system], [200, 1100]);
});
