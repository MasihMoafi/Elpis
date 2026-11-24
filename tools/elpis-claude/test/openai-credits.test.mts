import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import OpenAI from "openai";
import { promptContent, creditModels } from "../openai-credits.mts";
import { CreditTools } from "../openai-credits-tools.mts";

test("credit models come from the selected API organization", async () => {
  const client = new OpenAI({ apiKey: "fixture", fetch: async (url, init) => {
    assert.equal(String(url), "https://api.openai.com/v1/models");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture");
    return Response.json({ data: ["gpt-6.2-sol", "gpt-image-1", "gpt-6.2-sol", "gpt-6.2-astra"].map(id => ({ id, object: "model" })) });
  } });
  assert.deepEqual(await creditModels(client), ["gpt-6.2-sol", "gpt-6.2-astra"]);
});

test("the API receives the attached image and the accompanying text", () => {
  assert.deepEqual(promptContent([{ type: "text", text: "Describe" }, { type: "image", mimeType: "image/png", data: "YXNk" }]), [
    { type: "input_text", text: "Describe" }, { type: "input_image", image_url: "data:image/png;base64,YXNk", detail: "auto" },
  ]);
  assert.throws(() => promptContent([{ type: "audio", data: "YQ==", mimeType: "audio/wav" }]), /Unsupported/);
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
    assert.equal(await tools.run(name, '{"n":2}', async () => false, signal), "Permission denied.");
    assert.equal(calls, 0);
    const output = await tools.run(name, '{"n":2}', async (title, args) => { assert.equal(title, "local / sample"); assert.deepEqual(args, { n: 2 }); return true; }, signal);
    assert.match(output, /"text":"1"/);
    assert.equal(calls, 1);
  } finally {
    await tools.close();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
});
