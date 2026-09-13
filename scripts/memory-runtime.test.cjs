const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AppServer } = require("../editors/vscode/src/rpc");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-memory-runtime-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
const workspace = path.join(home, "context/workspaces",
  "project-" + crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12));
const memoryFile = path.join(home, "memories/MEMORY.md");
const checkpointFile = path.join(workspace, "ES.md");
const settingsFile = path.join(workspace, "memory-autosave.json");
for (const directory of [cwd, workspace, path.dirname(memoryFile)]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(settingsFile, '{"enabled":true}');
fs.writeFileSync(path.join(workspace, "admission.toml"), "memory = true\ncheckpoint = true\n");
fs.writeFileSync(path.join(workspace, "GOAL.md"), "# Goal\nVerify the Cedar release.\n");

let rpc;
let luna = 0;
let malformed = false;
let editDuringSave = false;
let holdMemory = false;
let memoryReached;
let releaseMemory;
let includeReasoning = false;
const requests = [];
const events = [];

const server = http.createServer(async (request, response) => {
  if (!request.url.includes("/responses")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  let text = "Acknowledged.";
  if (body.model === "gpt-5.6-luna") {
    luna++;
    assert.equal(body.tools?.length || 0, 0, "memory call exposed tools");
    assert.equal(body.text?.format?.type, "json_schema", "memory call omitted its schema");
    assert.equal(body.text.format.strict, true, "memory schema was not strict");
    assert.deepEqual(body.text.format.schema.required, ["checkpoint", "memory"]);
    if (holdMemory) {
      await new Promise(resolve => {
        releaseMemory = resolve;
        memoryReached();
      });
    }
    if (editDuringSave) fs.writeFileSync(memoryFile, "Manual correction: Cedar port 7713.");
    text = malformed ? "INVALID JSON" : JSON.stringify({
      checkpoint: "- [ ] Verify Cedar release [u1].",
      memory: "- Project Cedar uses port 5823; user prefers Celsius [u1].",
    });
  }
  const id = "r" + requests.length;
  const item = {
    type: "message", id: "m" + requests.length, role: "assistant", status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  const reasoning = includeReasoning && body.model !== "gpt-5.6-luna" ? {
    type: "reasoning", id: "reasoning_" + requests.length, summary: [],
    encrypted_content: "fixture_reasoning_for_queued_continuation",
  } : null;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const stream = [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0,
      item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0,
      content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0,
      content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 } } },
  ];
  if (reasoning) {
    for (const event of stream) {
      if (event.output_index !== undefined) event.output_index = 1;
    }
    stream.splice(1, 0,
      { type: "response.output_item.added", output_index: 0, item: reasoning },
      { type: "response.output_item.done", output_index: 0, item: reasoning });
    stream.at(-1).response.output.unshift(reasoning);
  }
  for (const event of stream) response.write("data: " + JSON.stringify(event) + "\n\n");
  response.end();
});

async function start() {
  const binary = process.argv[2] ||
    path.resolve(__dirname, "../codex-rs/target/local-release/codex-app-server");
  rpc = new AppServer(binary, cwd, {
    env: { ...process.env, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home },
  });
  rpc.on("disconnect", () => {});
  rpc.on("notification", message => events.push(message));
  rpc.on("request", message => rpc.respond(message.id, { decision: "decline" }));
  await rpc.request("initialize", {
    clientInfo: { name: "elpis_memory_test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized" });
  return (await rpc.request("thread/start", {
    model: "gpt-5.6-terra", cwd, approvalPolicy: "never", sandbox: "read-only",
  })).thread.id;
}

async function complete(threadId, method, params, afterStart = async () => {}) {
  let listener;
  let timer;
  const done = new Promise((resolve, reject) => {
    listener = message => {
      if (message.method === "turn/completed" && message.params.threadId === threadId) resolve();
    };
    rpc.on("notification", listener);
    timer = setTimeout(() => reject(Error("turn did not complete")), 30_000);
  });
  try {
    const started = await rpc.request(method, params);
    await afterStart(started);
    await done;
  } finally {
    clearTimeout(timer);
    rpc.removeListener("notification", listener);
  }
}

const turn = (threadId, text) => complete(threadId, "turn/start", {
  threadId, input: [{ type: "text", text }],
});
const compact = threadId => complete(threadId, "thread/compact/start", { threadId });

async function run() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gpt-5.6-terra"',
    'model_provider = "fixture"',
    "[model_providers.fixture]",
    'name = "Fixture"',
    'base_url = "http://127.0.0.1:' + server.address().port + '/v1"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");
  let thread = await start();
  await turn(thread, "Remember: project Cedar uses port 5823 and I prefer Celsius. Release verification remains unfinished.");
  assert.equal(luna, 1, "completed response did not save memory");
  await compact(thread);
  assert.equal(luna, 2, "compaction did not add exactly one Luna request");

  const receiptDirectory = path.join(workspace, "memory-saves");
  const receipts = fs.readdirSync(receiptDirectory).map(file =>
    JSON.parse(fs.readFileSync(path.join(receiptDirectory, file), "utf8")));
  assert.equal(receipts.length, 2);
  assert(receipts.every(receipt => ["preparation_ms", "request_ms", "commit_ms"]
    .every(field => Number.isSafeInteger(receipt.timing?.[field]) && receipt.timing[field] >= 0)),
  "committed receipts lack phase timings");
  assert(receipts.every(receipt => receipt.status === "committed" &&
    receipt.evidence.includes("Remember: project Cedar")), "receipts lack committed evidence");
  assert(receipts.every(receipt => JSON.parse(receipt.evidence).goal.includes("Verify the Cedar release")),
    "memory consolidation lost the workspace goal");
  assert.equal(fs.readFileSync(path.join(workspace, "GOAL.md"), "utf8"),
    "# Goal\nVerify the Cedar release.\n", "memory saving rewrote the goal");
  const saved = fs.readFileSync(memoryFile, "utf8");
  assert(saved.includes("5823"));

  rpc.dispose();
  thread = await start();
  const nextRequest = requests.length;
  await turn(thread, "What is the Cedar port?");
  assert(JSON.stringify(requests[nextRequest].input).includes(saved),
    "restart did not admit saved memory");

  malformed = true;
  await compact(thread);
  assert.equal(fs.readFileSync(memoryFile, "utf8"), saved, "invalid response changed memory");
  assert(events.some(event => JSON.stringify(event).includes("Memory save failed")),
    "failure was silent");

  malformed = false;
  editDuringSave = true;
  const checkpointBefore = fs.readFileSync(checkpointFile, "utf8");
  await compact(thread);
  assert.equal(fs.readFileSync(memoryFile, "utf8"), "Manual correction: Cedar port 7713.",
    "concurrent manual edit was overwritten");
  assert.equal(fs.readFileSync(checkpointFile, "utf8"), checkpointBefore,
    "rejected decision changed checkpoint");
  editDuringSave = false;

  const beforeSteer = requests.length;
  const reached = new Promise(resolve => { memoryReached = resolve; });
  holdMemory = true;
  includeReasoning = true;
  await complete(thread, "turn/start", {
    threadId: thread, input: [{ type: "text", text: "Finish this response." }],
  }, async started => {
    await reached;
    holdMemory = false;
    await rpc.request("turn/steer", {
      threadId: thread, expectedTurnId: started.turn.id,
      input: [{ type: "text", text: "QUEUED_DURING_MEMORY: also handle this message." }],
    });
    releaseMemory();
  });
  const mainRequests = requests.slice(beforeSteer).filter(request => request.model !== "gpt-5.6-luna");
  assert.equal(mainRequests.length, 2, "message arriving during saving was not processed");
  assert(JSON.stringify(mainRequests[1].input).includes("QUEUED_DURING_MEMORY"));
  assert(JSON.stringify(mainRequests[1].input).includes("fixture_reasoning_for_queued_continuation"),
    "reasoning expired before the queued continuation");
  includeReasoning = false;

  fs.writeFileSync(settingsFile, '{"enabled":false}');
  const beforeDisabled = luna;
  await compact(thread);
  await turn(thread, "A normal response with saving disabled.");
  assert.equal(luna, beforeDisabled, "disabled saver called Luna");
  console.log(JSON.stringify({ passed: true, luna, requests: requests.length, checks: [
    "save on completed response", "committed receipts retain evidence",
    "tool-free save before compaction", "fresh process admits saved memory",
    "invalid output preserves notes and warns", "concurrent manual edits preserved",
    "input arriving during memory saving retains reasoning in the same turn",
    "disabled turn and compaction make no memory request",
  ] }, null, 2));
}

run().catch(error => {
  fs.writeFileSync(path.join(root, "failure.txt"), error.stack);
  console.error(error.stack);
  process.exitCode = 1;
}).finally(() => {
  rpc?.dispose();
  server.close();
  if (process.exitCode) console.error("Failure evidence: " + root);
  else fs.rmSync(root, { recursive: true, force: true });
});
