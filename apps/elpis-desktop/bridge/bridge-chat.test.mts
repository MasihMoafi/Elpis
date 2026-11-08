import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { required, ROOT, fixture } from "./bridge.fixtures.mts";

test("an old chat shows the last usage its rollout recorded, plain or compressed, until live events replace it", async () => {
  const { restoredTokenUsage } = await import("./elpis-features.mts");
  const zlib = await import("node:zlib");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-rollout-usage-"));
  const usage = (total: number) => ({
    input_tokens: total - 100,
    cached_input_tokens: 10,
    cache_write_input_tokens: 0,
    output_tokens: 100,
    reasoning_output_tokens: 7,
    total_tokens: total,
  });
  const line = (payload: unknown) => JSON.stringify({ timestamp: "2026-10-16T00:00:00Z", type: "event_msg", payload });
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { id: ROOT } }),
    line({
      type: "token_count",
      info: { total_token_usage: usage(30000), last_token_usage: usage(30000), model_context_window: 200000 },
    }),
    line({
      type: "token_count",
      info: { total_token_usage: usage(70000), last_token_usage: usage(40000), model_context_window: 200000 },
      rate_limits: null,
    }),
    // A large tool result after it, and a rate-limit-only count with no usage, as real rollouts have.
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(300000) } }),
    line({ type: "token_count", info: null, rate_limits: { primary: null } }),
  ];
  const plain = path.join(temp, "rollout-a.jsonl"),
    packed = path.join(temp, "rollout-b.jsonl.zst"),
    empty = path.join(temp, "rollout-c.jsonl");
  await fs.writeFile(plain, lines.join("\n") + "\n");
  await fs.writeFile(packed, zlib.zstdCompressSync(Buffer.from(lines.join("\n") + "\n")));
  await fs.writeFile(empty, lines[0] + "\n");
  const expected = {
    total: {
      inputTokens: 69900,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 7,
      totalTokens: 70000,
    },
    last: {
      inputTokens: 39900,
      cachedInputTokens: 10,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 7,
      totalTokens: 40000,
    },
    modelContextWindow: 200000,
    contextAttribution: null,
  };
  assert.deepEqual(
    await restoredTokenUsage(plain),
    expected,
    "the last count that carries usage, read from the end of the file",
  );
  assert.deepEqual(await restoredTokenUsage(packed), expected, "compressed rollouts are read the same way");
  assert.equal(await restoredTokenUsage(empty), null);
  for (const bad of [null, "rollout.jsonl", path.join(temp, "missing.jsonl"), path.join(temp, "notes.txt")])
    assert.equal(await restoredTokenUsage(bad), null, `${bad} is not read`);

  const { client, socket, threads } = fixture();
  await client.initialize();
  required(threads.get(ROOT)).path = plain;
  const restored = await client.context(ROOT);
  assert.deepEqual(
    restored.ledger,
    { used: 40000, window: 200000, categories: [] },
    "measured numbers as soon as the chat opens; shares wait for the next request, as in the TUI",
  );
  assert.equal(restored.availability.tokenUsage, "restored");
  assert.equal(
    socket.sent.some(message => message.method === "thread/resume"),
    false,
    "reading usage does not resume the chat",
  );
  socket.emit(
    "message",
    JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: { threadId: ROOT, tokenUsage: { last: { totalTokens: 41000 }, modelContextWindow: 200000 } },
    }),
  );
  const live = await client.context(ROOT);
  assert.equal(live.ledger.used, 41000);
  assert.equal(live.availability.tokenUsage, "live");
  client.close();
});

test("encrypted reasoning weighs what the model is sent, as the engine counts it (A225, A260)", async () => {
  const { sizedItem } = await import("./elpis-features.mts");
  const tokens = (item: Parameters<typeof sizedItem>[0]): [string, number] => {
    const [key, bytes] = sizedItem(item);
    return [key, Math.ceil(bytes / 4)];
  };
  const reasoning = (length: number) => ({ type: "reasoning", summary: [], encrypted_content: "g".repeat(length) });
  const old = (length: number) => Math.ceil(Math.max(0, Math.floor((length * 3) / 4) - 650) / 4);
  // The same values the engine's tests pin (core elpis_context_attribution_tests.rs).
  for (const [length, expected] of [
    [0, 0],
    [1287, 0],
    [1288, 1],
    [2701, 100],
    [7287, 425],
    [142687, 10000],
  ] as [number, number][])
    assert.deepEqual(tokens(reasoning(length)), ["reasoning", expected], `${length} characters`);
  assert.deepEqual(
    tokens({ type: "reasoning", summary: [{ type: "summary_text", text: "plain" }] }),
    ["reasoning", 0],
    "no encrypted content weighs nothing",
  );
  for (const type of ["compaction", "context_compaction"])
    assert.deepEqual(
      tokens({ type, encrypted_content: "g".repeat(57272) }),
      ["reasoning", 3960],
      `a ${type} at the same rate`,
    );
  // His chats: every gpt-6.1-sol response with reasoning, its reported reasoning tokens then each item's encrypted length.
  const measured: { chats: [number, ...number[]][][] } = JSON.parse(
    await fs.readFile(new URL("../../../codex-rs/core/src/elpis_reasoning_cost.json", import.meta.url), "utf8"),
  );
  let reported = 0,
    estimated = 0,
    before = 0;
  for (const chat of measured.chats) {
    const sum = (rows: number[]) => rows.reduce((total, value) => total + value, 0);
    const chatReported = sum(chat.map(([count]) => count)),
      chatEstimated = sum(chat.flatMap(([, ...lengths]) => lengths.map(length => tokens(reasoning(length))[1])));
    if (chat.length >= 20)
      assert.ok(
        chatEstimated / chatReported >= 0.95 && chatEstimated / chatReported < 1.2,
        `a chat at ${(chatEstimated / chatReported).toFixed(3)}`,
      );
    reported += chatReported;
    estimated += chatEstimated;
    before += sum(chat.flatMap(([, ...lengths]) => lengths.map(old)));
  }
  assert.equal(reported, 2625861);
  assert.ok(Math.abs(estimated / reported - 1) < 0.03, `all chats at ${(estimated / reported).toFixed(3)}`);
  assert.ok(before / reported > 2.5, "the decoded-size estimate it replaces counted nearly three times what was sent");
  // Any length: rounded up by less than a token, never more as it shrinks, never above the old estimate and below it wherever it counts anything.
  let seed = 0x5eed1024,
    last = -1;
  const lengths = [
    0,
    1,
    866,
    867,
    1286,
    1287,
    1288,
    1592,
    2701,
    2702,
    ...Array.from({ length: 500 }, () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) % 70000),
  ].sort((a, b) => a - b);
  for (const length of lengths) {
    const [, count] = tokens(reasoning(length)),
      exact = Math.max(0, length - 1287) / 14.14;
    assert.ok(count >= exact - 1e-9 && count < exact + 1, `${length}: ${count}`);
    assert.ok(count >= last, "longer reasoning never weighs less");
    last = count;
    assert.ok(count <= old(length) && (count === 0 || count < old(length)), `${length}: ${count} vs ${old(length)}`);
  }
});

test("reasoning cost holds on held-out responses after the fit window", async () => {
  const { sizedItem } = await import("./elpis-features.mts");
  // Independent 25 Oct gpt-6.1-sol replies; numeric-only extraction documented in the core test.
  const responses: [number, ...number[]][] = JSON.parse(
    await fs.readFile(new URL("../../../codex-rs/core/src/elpis_reasoning_cost_heldout.json", import.meta.url), "utf8"),
  );
  let reported = 0,
    estimated = 0;
  for (const [count, ...lengths] of responses) {
    reported += count;
    for (const length of lengths) {
      const [key, bytes] = sizedItem({ type: "reasoning", encrypted_content: "g".repeat(length) });
      assert.equal(key, "reasoning");
      estimated += Math.ceil(bytes / 4);
    }
  }
  assert.equal(responses.length, 846);
  assert.equal(reported, 564199);
  assert.ok(Math.abs(estimated / reported - 1) < 0.03, `held-out responses at ${(estimated / reported).toFixed(3)}`);
});

test("an old chat shows category shares estimated from its saved transcript, until the engine sends its own", async () => {
  const { rolloutShares, contextLedger } = await import("./elpis-features.mts");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-rollout-shares-"));
  const record = (type: string, payload: unknown) =>
    JSON.stringify({ timestamp: "2026-10-17T00:00:00Z", type, payload });
  const item = (payload: unknown) => record("response_item", payload);
  const text = (role: string, kind: string, body: string) =>
    item({ type: "message", role, content: [{ type: kind, text: body }] });
  const count = (total: number, window = 20000) =>
    record("event_msg", {
      type: "token_count",
      info: {
        total_token_usage: { total_tokens: total },
        last_token_usage: { total_tokens: total },
        model_context_window: window,
      },
    });
  // The engine's classifier (core elpis_context_attribution.rs) on bytes ÷ 4, rounded up, per item.
  const lines = [
    record("session_meta", { id: ROOT, base_instructions: { text: "S".repeat(400) } }),
    text("developer", "input_text", "D".repeat(800)),
    text("user", "input_text", "U".repeat(40)),
    text("assistant", "output_text", "A".repeat(100)),
    item({ type: "reasoning", summary: [], encrypted_content: "E".repeat(2000) }),
    item({ type: "function_call", name: "exec", arguments: "a".repeat(87), call_id: "c1" }),
    item({ type: "function_call_output", call_id: "c1", output: "R".repeat(3998) }),
    count(2000),
  ];
  const write = async (name: string, rows: string[]) => {
    const file = path.join(temp, name);
    await fs.writeFile(file, rows.join("\n") + "\n");
    return file;
  };
  const plain = await write("rollout-a.jsonl", lines);
  const shares = await rolloutShares(plain);
  assert.deepEqual(
    shares,
    {
      systemInstructions: 100,
      developerMessages: 200,
      userMessages: 10,
      agentMessages: 25,
      reasoning: 51,
      toolCalls: 25,
      toolResults: 1000,
      toolDefinitions: 0,
      outputSchema: 0,
      unrecognizedItems: 0,
    },
    "each item counted as the engine counts it: text bytes ÷ 4, a reasoning blob past its 1,287-character overhead at 14.14 characters a token, a call by name, namespace and arguments",
  );
  const usage = (total: number) => ({ last: { totalTokens: total }, modelContextWindow: 20000 });
  const ledger = contextLedger(usage(2000), shares);
  assert.deepEqual(
    ledger.categories.map(row => [row.label, row.tokens]),
    [
      ["User messages", 10],
      ["Agent messages", 25],
      ["Reasoning + compaction", 51],
      ["Tool calls", 25],
      ["Tool results", 1000],
      ["System instructions", 100],
      ["Developer messages", 200],
      ["Tool definitions + schema", 589],
    ],
    "what the transcript cannot hold (the tool definitions) is the rest of the measured total",
  );
  assert.ok("basis" in ledger);
  assert.equal(ledger.basis, "transcript");
  assert.equal(
    ledger.categories.reduce((sum, row) => sum + row.tokens, 0),
    2000,
  );
  const engine = contextLedger(
    { ...usage(2000), contextAttribution: { userMessages: 5, toolDefinitions: 5, estimatedTotal: 10 } },
    shares,
  );
  assert.ok("basis" in engine);
  assert.equal(engine.basis, "engine", "the engine's own shares win over the transcript");
  assert.deepEqual(
    engine.categories.map(row => row.tokens),
    [1000, 1000],
  );
  assert.deepEqual(contextLedger(usage(2000), null), { used: 2000, window: 20000, categories: [] });

  // A transcript that cannot be what the model last saw is not attributed: far more than was measured, a compaction without its
  // replacement history, a rolled-back turn. With the replacement history, only what follows it counts.
  assert.equal(
    contextLedger(usage(1000), shares).categories.length,
    0,
    "the transcript is bigger than the measured context (history was shortened): unavailable",
  );
  assert.equal(
    await rolloutShares(await write("rollout-b.jsonl", [...lines, record("compacted", { message: "summary" })])),
    null,
  );
  assert.equal(
    await rolloutShares(
      await write("rollout-c.jsonl", [...lines, record("event_msg", { type: "thread_rolled_back", num_turns: 1 })]),
    ),
    null,
  );
  const compacted = await rolloutShares(
    await write("rollout-d.jsonl", [
      ...lines,
      record("compacted", {
        message: "summary",
        replacement_history: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "U".repeat(80) }] },
        ],
        window_number: 2,
      }),
      text("assistant", "output_text", "A".repeat(40)),
    ]),
  );
  assert.deepEqual(
    [
      required(compacted).userMessages,
      required(compacted).agentMessages,
      required(compacted).toolResults,
      required(compacted).systemInstructions,
    ],
    [20, 10, 0, 100],
  );
  for (const bad of [null, "rollout.jsonl", path.join(temp, "missing.jsonl"), path.join(temp, "notes.txt")])
    assert.equal(await rolloutShares(bad), null, `${bad} is not read`);

  // Through the bridge: a chat opened from its rollout has its shares at once, marked as estimated; the engine's replace them.
  const { client, socket, threads } = fixture();
  await client.initialize();
  required(threads.get(ROOT)).path = plain;
  const opened = await client.context(ROOT);
  assert.ok("basis" in opened.ledger);
  assert.equal(opened.ledger.basis, "transcript");
  assert.equal(opened.ledger.used, 2000);
  assert.equal(required(opened.ledger.categories.find(row => row.id === "toolResults")).tokens, 1000);
  assert.ok(opened.tokenUsage);
  assert.equal(opened.tokenUsage.contextAttribution, null, "the usage itself still says no shares were reported");
  // The ledger's Compact session, as the terminal's /compact: not while the chat is in the middle of a turn.
  assert.deepEqual(opened.compact, { available: true });
  required(threads.get(ROOT)).status = { type: "active" };
  assert.deepEqual((await client.context(ROOT)).compact, {
    available: false,
    reason: "Available when Elpis finishes this turn",
  });
  required(threads.get(ROOT)).status = { type: "idle" };
  socket.emit(
    "message",
    JSON.stringify({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: ROOT,
        tokenUsage: {
          last: { totalTokens: 2000 },
          modelContextWindow: 20000,
          contextAttribution: { userMessages: 1, toolResults: 3, estimatedTotal: 4 },
        },
      },
    }),
  );
  const live = await client.context(ROOT);
  assert.ok("basis" in live.ledger);
  assert.equal(live.ledger.basis, "engine");
  assert.deepEqual(
    live.ledger.categories.map(row => [row.id, row.tokens]),
    [
      ["userMessages", 500],
      ["toolResults", 1500],
    ],
  );
  client.close();
});
