import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rolloutAgentModel } from "./rollout-readers.mts";
import { internal_withTurnModels } from "./client-rollout-cache.mts";

test("recent model labels open a 500 MB rollout without replaying its prefix", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "elpis-rollout-perf-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "large.jsonl"),
    handle = await fs.open(file, "w");
  // A sparse prefix makes full scans fail the I/O contract without writing 500 MB for every test run.
  await handle.truncate(500_000_000);
  await handle.write(
    JSON.stringify({ type: "turn_context", payload: { turn_id: "oldest", model: "original" } }) + "\n",
    0,
  );
  const line =
    JSON.stringify({ type: "turn_context", payload: { turn_id: "latest", model: "recent", effort: "high" } }) + "\n";
  await handle.write("\n" + line, 500_000_000);
  await handle.close();
  // rchar counts bytes delivered by read(), including cached and sparse-file
  // bytes. fsRead counts physical blocks and would miss a full cached scan.
  const readBytes = async () => Number(/^rchar: (\d+)$/m.exec(await fs.readFile("/proc/self/io", "utf8"))?.[1]);
  const start = process.platform === "linux" ? await readBytes() : 0;
  const state = { turnModels: new Map() };
  const entries = await internal_withTurnModels<{ turnId: string; model?: string }>(state, file, [
    { turnId: "latest" },
    { turnId: "unrecorded" },
  ]);
  assert.equal(entries[0]?.model, "recent");
  assert.equal(entries[1]?.model, undefined);
  assert.deepEqual(await rolloutAgentModel(file, "thread"), { model: "recent", reasoningEffort: "high" });
  if (process.platform === "linux")
    assert.ok(
      (await readBytes()) - start < 16 * 1024 * 1024 + 4096,
      "recent metadata must read under 16 MiB, including cached and sparse-file bytes",
    );
  const first = await internal_withTurnModels<{ turnId: string; model?: string }>(state, file, [{ turnId: "oldest" }]);
  assert.equal(first[0]?.model, undefined, "the initial read does not scan an unbounded prefix for optional labels");
  const older = await internal_withTurnModels<{ turnId: string; model?: string }>(
    state,
    file,
    [{ turnId: "oldest" }],
    true,
  );
  assert.equal(older[0]?.model, "original", "loading older history preserves its actual recorded model");
  await fs.appendFile(file, JSON.stringify({ type: "turn_context", payload: { turn_id: "partial" } }) + "\n");
  assert.deepEqual(
    await rolloutAgentModel(file, "thread"),
    { model: "recent", reasoningEffort: "high" },
    "incomplete metadata cannot erase the last recorded model",
  );
});
