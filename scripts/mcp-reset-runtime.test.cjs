const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

if (process.argv[2] === "--mcp-fixture") {
  const record = event => fs.appendFileSync(process.env.MCP_RESET_LOG,
    JSON.stringify({ event, pid: process.pid, generation: process.env.MCP_RESET_GENERATION }) + "\n");
  record("start");
  process.on("exit", () => record("exit"));
  process.on("SIGTERM", () => process.exit(0));
  const lines = require("node:readline").createInterface({ input: process.stdin });
  lines.on("close", () => process.exit(0));
  lines.on("line", line => {
    const request = JSON.parse(line);
    record(request.method);
    if (request.id === undefined) return;
    let result = {};
    if (request.method === "initialize") result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "reset-fixture", version: "1" },
    };
    if (request.method === "tools/list") result = { tools: [{
      name: "generation_" + process.env.MCP_RESET_GENERATION,
      description: "Offline MCP reload fixture",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] };
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  });
} else {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}

async function run() {
  const { AppServer } = require("../editors/vscode/src/rpc");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-mcp-reset-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  const log = path.join(root, "mcp.jsonl");
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const requests = [];
  const events = [];
  const server = http.createServer(async (request, response) => {
    if (!request.url.includes("/responses")) {
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    const id = "response_" + requests.length;
    const item = { type: "message", id: "message_" + requests.length, role: "assistant",
      status: "completed", content: [{ type: "output_text", text: "Offline fixture completed.", annotations: [] }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id, status: "completed", output: [item],
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } },
    ]) response.write("data: " + JSON.stringify(event) + "\n\n");
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const writeConfig = generation => fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gpt-5.6-terra"', 'model_provider = "fixture"',
    '[model_providers.fixture]', 'name = "Offline fixture"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
    'wire_api = "responses"', 'requires_openai_auth = false',
    '[mcp_servers.reset_fixture]', `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(__filename)}, "--mcp-fixture"]`,
    '[mcp_servers.reset_fixture.env]', `MCP_RESET_LOG = ${JSON.stringify(log)}`,
    `MCP_RESET_GENERATION = ${JSON.stringify(generation)}`, "",
  ].join("\n"));
  writeConfig("one");
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");
  const binary = process.argv[2] || path.resolve(__dirname, "../codex-rs/target/local-release/codex-app-server");
  const rpc = new AppServer(binary, cwd, { env: { ...process.env, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home } });
  rpc.child.stderr.on("data", data => fs.appendFileSync(path.join(root, "stderr.log"), data));
  rpc.on("disconnect", () => {});
  rpc.on("notification", event => events.push(event));
  rpc.on("request", request => rpc.respond(request.id, { decision: "decline" }));
  const records = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    await rpc.request("initialize", { clientInfo: { name: "elpis_mcp_reset_test", version: "1" },
      capabilities: { experimentalApi: true } });
    rpc.send({ method: "initialized" });
    const threadId = (await rpc.request("thread/start", { cwd, approvalPolicy: "never", sandbox: "read-only" })).thread.id;
    const turn = async () => {
      const start = events.length;
      await rpc.request("turn/start", { threadId, input: [{ type: "text", text: "Report the available tool generation." }] });
      const deadline = Date.now() + 30000;
      while (!events.slice(start).some(event => event.method === "turn/completed" && event.params.threadId === threadId)) {
        assert(Date.now() < deadline, "offline turn timed out"); await pause(25);
      }
    };
    await turn();
    assert(records().some(record => record.event === "tools/list" && record.generation === "one"), "initial MCP tools were not discovered");
    const first = records().find(record => record.event === "start" && record.generation === "one");
    assert(first, "initial MCP process did not start");
    writeConfig("two");
    await turn();
    assert(!records().some(record => record.generation === "two"), "negative control unexpectedly reloaded configuration");
    const beforeReset = requests.length;
    await rpc.request("config/mcpServer/reload", null);
    await pause(200);
    assert.equal(requests.length, beforeReset, "reset caused an unsolicited model request");
    assert(!records().some(record => record.generation === "two"), "queued reset unexpectedly reconnected before next turn");
    await turn();
    assert.equal(requests.length, beforeReset + 1, "next user turn issued extra model requests");
    assert(records().some(record => record.event === "tools/list" && record.generation === "two"), "new environment did not reach MCP tool discovery");
    const replacement = records().find(record => record.event === "start" && record.generation === "two");
    assert(replacement && replacement.pid !== first.pid, "MCP process was not replaced");
    const deadline = Date.now() + 5000;
    while (!records().some(record => record.event === "exit" && record.pid === first.pid)) {
      assert(Date.now() < deadline, "old MCP connection/process remained alive"); await pause(25);
    }
    const result = { pass: true, root, requests: requests.length, firstPid: first.pid,
      replacementPid: replacement.pid, changedEnvironmentLoaded: true, noUnsolicitedTurn: true,
      negativeControlPassed: true, records: records() };
    fs.writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    fs.writeFileSync(path.join(root, "failure.json"), JSON.stringify({ error: error.message, records: records(), events,
      requests }, null, 2));
    throw new Error(`${error.message}; evidence: ${root}`, { cause: error });
  } finally {
    rpc.dispose();
    await new Promise(resolve => server.close(resolve));
  }
}
