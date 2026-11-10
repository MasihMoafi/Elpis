// 10 Nov, Masih: imported Claude Code chats showed "[external_agent_tool_call: Bash]" text instead of steps.
import test from "node:test";
import assert from "node:assert/strict";
import { expandImportedTools } from "./imported-tools.ts";

const reply = (id: string, text: string, turnId = "t1") => ({ turnId, item: { id, type: "agentMessage", text } });

test("an imported reply becomes its text and steps; a result in the next message joins its call", () => {
  const entries = [
    { turnId: "t1", item: { id: "u", type: "userMessage" } },
    reply(
      "a",
      "Checking the tests.\n\n[external_agent_tool_call: Bash]\ndescription: Type-check and rerun router tests\ncommand: cd app; tsc\n  --noEmit\n[/external_agent_tool_call]\n\n[external_agent_tool_call: Edit]\nfile: /repo/bridge/router/app.test.mts\n[/external_agent_tool_call]",
    ),
    reply("b", "[external_agent_tool_result]\npass 584\n[/external_agent_tool_result]\n\n[external_agent_tool_result: error]\nString not found\n[/external_agent_tool_result]"),
    reply("c", "All green."),
  ];
  const items = expandImportedTools(entries).map(entry => entry.item);
  assert.deepEqual(
    items.map(item => item.type),
    ["userMessage", "agentMessage", "commandExecution", "dynamicToolCall", "agentMessage"],
  );
  assert.equal(items[1]!.text, "Checking the tests.");
  assert.equal(items[2]!.command, "cd app; tsc\n  --noEmit");
  assert.equal(items[2]!.description, "Type-check and rerun router tests");
  assert.equal(items[2]!.aggregatedOutput, "pass 584");
  assert.equal(items[3]!.tool, "Edit app.test.mts");
  assert.deepEqual(items[3]!.contentItems, [{ type: "inputText", text: "String not found" }]);
  assert.ok(items[3]!.error, "an error result marks its step failed");
  assert.equal(items[4]!.text, "All green.");
  assert.ok(!JSON.stringify(items).includes("external_agent_tool"), "no tag text is left");
});

test("a result without a call still shows as a step, and chats without tags pass through unchanged", () => {
  const plain = [reply("x", "Hello.")];
  assert.equal(expandImportedTools(plain), plain);
  const items = expandImportedTools([reply("r", "[external_agent_tool_result]\nok\n[/external_agent_tool_result]", "t2")]).map(e => e.item);
  assert.deepEqual(items.map(item => [item.type, item.tool]), [["dynamicToolCall", "Tool result"]]);
});
