import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordedClaudeEnd } from "../claude-turn-record.mjs";

const user = text => ({ type: "user", message: { content: [{ type: "text", text }] } });
const final = (text, more = {}) => ({ type: "assistant", uuid: "answer", message: { stop_reason: "end_turn", content: [{ type: "text", text }] }, ...more });
const jsonl = records => records.map(JSON.stringify).join("\n") + "\n";

test("recovery reads only this turn and requires a terminal answer after every accepted input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a124-record-"));
  const file = path.join(root, "session.jsonl");
  const earlier = jsonl([user("قدیمی"), final("an earlier answer")]);
  const offset = Buffer.byteLength(earlier);
  await fs.writeFile(file, earlier);
  assert.equal(await recordedClaudeEnd(file, offset, ["hello"]), null, "an earlier answer cannot finish a new turn");
  await fs.appendFile(file, jsonl([user("hello"), final("before the steer")]));
  assert.equal(await recordedClaudeEnd(file, offset, ["hello", "and this"]), null, "a final predating the last injected message cannot end the turn");
  await fs.appendFile(file, jsonl([user("and this")]));
  assert.equal(await recordedClaudeEnd(file, offset, ["hello", "and this"]), null, "a later user message still awaits its answer");
  await fs.appendFile(file, jsonl([final("subagent answer", { isSidechain: true })]));
  assert.equal(await recordedClaudeEnd(file, offset, ["hello", "and this"]), null, "a subagent cannot end its parent's turn");
  await fs.appendFile(file, jsonl([final("پاسخ آخر")]));
  assert.deepEqual(await recordedClaudeEnd(file, offset, ["hello", "and this"]), { id: "answer", text: "پاسخ آخر" });
  await fs.appendFile(file, '{"type":"user"');
  assert.equal(await recordedClaudeEnd(file, offset, ["hello", "and this"]), null, "a partial append cannot prove the turn is over");
});

test("tool output, tool use, missing files, corrupt records and reordered inputs cannot fake a completed turn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "a124-record-")), file = path.join(root, "session.jsonl");
  assert.equal(await recordedClaudeEnd(file, 0, ["one"]), null);
  for (const records of [
    [user("one"), { type: "assistant", message: { stop_reason: "tool_use", content: [{ type: "text", text: "working" }] } }],
    [user("one"), final("done"), { type: "user", message: { content: [{ type: "tool_result", content: "still working" }] } }],
    [user("two"), user("one"), final("wrong order")],
    [user("one"), final("")],
  ]) {
    await fs.writeFile(file, jsonl(records));
    assert.equal(await recordedClaudeEnd(file, 0, records.length === 3 && records[0].message.content[0].text === "two" ? ["one", "two"] : ["one"]), null);
  }
  await fs.writeFile(file, "not json\n" + jsonl([user("one"), final("done")]));
  assert.equal(await recordedClaudeEnd(file, 0, ["one"]), null);
});
