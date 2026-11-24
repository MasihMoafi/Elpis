import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI from "openai";
import { buildCreditRequestParams, creditEffortsForModel, creditModels, parseCreditEffort, promptContent, streamCreditResponse } from "../openai-credits.mts";
import { CreditTools } from "../openai-credits-tools.mts";
import { createTestTempDir, removeTestTempDir } from "./temp-root.mts";

test("credit models come from the selected API organization", async () => {
  const client = new OpenAI({ apiKey: "fixture", fetch: async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture");
    return Response.json({ data: ["gpt-6.2-sol", "gpt-image-1", "gpt-6.2-sol", "gpt-6.2-astra"].map(id => ({ id, object: "model" })) });
  } });
  assert.deepEqual(await creditModels(client), ["gpt-6.2-sol", "gpt-6.2-astra"]);
});

test("credit effort metadata excludes sign-in-only ultra and builds validated requests", () => {
  const astra = creditEffortsForModel("gpt-6.2-astra");
  assert.deepEqual(astra.levels.map(l => l.value), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(astra.defaultEffort, "low");
  assert.equal(creditEffortsForModel("gpt-6-sol").defaultEffort, "medium");
  assert.deepEqual(creditEffortsForModel("gpt-unknown"), { levels: [], defaultEffort: null });

  assert.deepEqual(parseCreditEffort("gpt-6.2-astra", "high"), { ok: true, effort: "high" });
  assert.deepEqual(parseCreditEffort("gpt-6.2-astra", "default"), { ok: true, effort: undefined });
  assert.deepEqual(parseCreditEffort("gpt-6.2-astra", null), { ok: true, effort: undefined });
  assert.deepEqual(parseCreditEffort("gpt-6.2-astra", "ultra"), { ok: false });
  assert.deepEqual(parseCreditEffort("gpt-6.2-astra", "none"), { ok: false });

  const supported = buildCreditRequestParams({ model: "gpt-6.2-astra", effort: "xhigh", input: [], tools: [] });
  assert.deepEqual(supported.reasoning, { effort: "xhigh" });
  const unsupported = buildCreditRequestParams({ model: "gpt-6.2-astra", effort: "ultra", input: [], tools: [] });
  assert.equal(unsupported.reasoning, undefined);
});

test("the API receives the attached image and the accompanying text", () => {
  assert.deepEqual(promptContent([{ type: "text", text: "Describe" }, { type: "image", mimeType: "image/png", data: "YXNk" }]), [
    { type: "input_text", text: "Describe" }, { type: "input_image", image_url: "data:image/png;base64,YXNk", detail: "auto" },
  ]);
  assert.throws(() => promptContent([{ type: "audio", data: "YQ==", mimeType: "audio/wav" }]), /Unsupported/);
});

test("streamed function calls can be sent back with a tool result", async () => {
  const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "{}" };
  const answer = { type: "message", role: "assistant", id: "msg_1", status: "completed", content: [{ type: "output_text", text: "mint", annotations: [] }] };
  const result = { type: "function_call_output" as const, call_id: "call_1", output: "mint" };
  let requests = 0;
  const client = new OpenAI({ apiKey: "fixture", fetch: async (_, init) => {
    const body = JSON.parse(String(init?.body));
    if (++requests === 2) assert.deepEqual(body.input, [call, result]);
    const response = { type: "response.completed", response: { status: "completed", output: [requests === 1 ? call : answer] } };
    return new Response(`data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const options = { model: "fixture", stream: true as const };
  const signal = AbortSignal.timeout(3000);
  const first = await streamCreditResponse(client, { ...options, input: "read" }, signal, async () => {});
  const item = first.output[0];
  assert.ok(item?.type === "function_call");
  const second = await streamCreditResponse(client, { ...options, input: [item, result] }, signal, async () => {});
  assert.deepEqual(second.output, [answer]);
});

test("an advertised MCP tool executes only after permission for its arguments", async () => {
  let calls = 0;
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    if (msg.id == null) { res.writeHead(202).end(); return; }
    const result = msg.method === "initialize" ? { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : msg.method === "tools/list" ? { tools: [{ name: "sample", inputSchema: { type: "object", properties: { n: { type: "integer" } } } }] }
      : msg.method === "tools/call" ? { content: [{ type: "text", text: String(++calls) }] } : {};
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const tools = new CreditTools(), signal = AbortSignal.timeout(8000);
  try {
    await tools.connect([{ type: "http", name: "local", url: `http://127.0.0.1:${address.port}`, headers: [] }], process.cwd(), signal);
    const name = tools.definitions[0]!.name;
    const denied = await tools.run(name, '{"n":2}', async () => false, signal);
    assert.equal(denied.output, "Permission denied.");
    assert.equal(denied.failed, true);
    assert.equal(calls, 0);
    const executed = await tools.run(name, '{"n":2}', async ({ title, rawInput, requiresApproval }) => {
      assert.equal(title, "local / sample");
      assert.equal(requiresApproval, true);
      assert.deepEqual(rawInput, { n: 2 });
      return true;
    }, signal);
    assert.match(executed.output, /"text":"1"/);
    assert.equal(executed.failed, false);
    assert.equal(calls, 1);
  } finally {
    await tools.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});

test("workspace tools run bash and file edits inside cwd and enforce sandbox and read-only restrictions", async t => {
  const root = createTestTempDir(path.join(os.tmpdir(), "elpis-credit-ws-"));
  t.after(() => removeTestTempDir(root));
  const cwd = path.join(root, "ws");
  const outside = path.join(root, "outside");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, path.join(cwd, "escape-link"));

  const signal = AbortSignal.timeout(10_000);
  const wsTools = new CreditTools();
  wsTools.registerWorkspace({ cwd, sandbox: "workspace-write", readOnly: false, disabled: false });
  assert.deepEqual(wsTools.definitions.map(d => d.name), [
    "read_file", "list_directory", "glob_files", "grep_search", "bash", "write_file", "edit_file",
  ]);

  let approvalCount = 0;
  const approveAll = async ({ requiresApproval }: { requiresApproval: boolean }) => {
    if (requiresApproval) approvalCount++;
    return true;
  };
  const writeRes = await wsTools.run("write_file", JSON.stringify({ path: "scratch.txt", content: "alpha\nbeta\n" }), approveAll, signal);
  assert.equal(writeRes.failed, false);
  const editRes = await wsTools.run("edit_file", JSON.stringify({ path: "scratch.txt", old_string: "beta", new_string: "gamma" }), approveAll, signal);
  assert.equal(editRes.failed, false);
  assert.equal(readFileSync(path.join(cwd, "scratch.txt"), "utf8"), "alpha\ngamma\n");
  const readRes = await wsTools.run("read_file", JSON.stringify({ path: "scratch.txt" }), approveAll, signal);
  assert.equal(readRes.failed, false);
  assert.match(readRes.output, /gamma/);

  const previousKey = process.env.OPENAI_CREDITS_API_KEY;
  process.env.OPENAI_CREDITS_API_KEY = "fixture-not-for-child";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENAI_CREDITS_API_KEY;
    else process.env.OPENAI_CREDITS_API_KEY = previousKey;
  });
  const bashRes = await wsTools.run("bash", JSON.stringify({ command: 'test -z "${OPENAI_CREDITS_API_KEY+x}" && echo credits-ok && pwd' }), approveAll, signal);
  assert.equal(bashRes.failed, false);
  assert.match(bashRes.toolResponse?.stdout ?? "", /credits-ok/);
  assert.equal(approvalCount, 3);

  // Declining approval must not modify disk.
  const deniedWrite = await wsTools.run("write_file", JSON.stringify({ path: "scratch.txt", content: "overwritten" }), async () => false, signal);
  assert.equal(deniedWrite.failed, true);
  assert.equal(readFileSync(path.join(cwd, "scratch.txt"), "utf8"), "alpha\ngamma\n");

  // Workspace-write blocks ../ and symlink escapes before approval, and bwrap blocks bash writes outside cwd.
  let escapePrompted = false;
  const escaped = await wsTools.run("write_file", JSON.stringify({ path: "../outside/pwn.txt", content: "no" }), async () => { escapePrompted = true; return true; }, signal);
  assert.equal(escaped.failed, true);
  assert.equal(escapePrompted, false);
  const symlinkEscaped = await wsTools.run("write_file", JSON.stringify({ path: "escape-link/pwn.txt", content: "no" }), async () => { escapePrompted = true; return true; }, signal);
  assert.equal(symlinkEscaped.failed, true);
  assert.equal(escapePrompted, false);

  const outsideHostDir = createTestTempDir(path.join(os.homedir(), ".cache", "elpis-tests", "bwrap-ro-"));
  t.after(() => removeTestTempDir(outsideHostDir));
  const blockedBash = await wsTools.run("bash", JSON.stringify({ command: `touch ${JSON.stringify(path.join(outsideHostDir, "nope.txt"))}` }), approveAll, signal);
  assert.equal(blockedBash.failed, true);
  assert.match(blockedBash.toolResponse?.stderr ?? "", /Read-only file system/i);

  // Read-only session omits mutating tools and rejects direct execution attempts.
  writeFileSync(path.join(cwd, "ro.txt"), "safe", "utf8");
  const roTools = new CreditTools();
  roTools.registerWorkspace({ cwd, sandbox: "read-only", readOnly: true, disabled: false });
  assert.deepEqual(roTools.definitions.map(d => d.name), ["read_file", "list_directory", "glob_files", "grep_search"]);
  const blockedEdit = await roTools.run("edit_file", JSON.stringify({ path: "ro.txt", old_string: "safe", new_string: "bad" }), approveAll, signal);
  assert.equal(blockedEdit.failed, true);
  assert.equal(readFileSync(path.join(cwd, "ro.txt"), "utf8"), "safe");

  const emptyTools = new CreditTools();
  emptyTools.registerWorkspace({ cwd, sandbox: "danger-full-access", readOnly: false, disabled: true });
  assert.equal(emptyTools.definitions.length, 0);
});
