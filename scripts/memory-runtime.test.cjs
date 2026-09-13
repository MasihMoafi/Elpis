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
let sourceId;
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
let alteredCitation = null;
let alteredCheckpointCitation = null;
let editDuringSave = false;
let holdMemory = false;
let memoryReached;
let releaseMemory;
let includeReasoning = false;
let largeResponse = true;
let requiredUserEvidence;
let renumberUnchangedFact = false;
let memoryText;
let latestSourceId;
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
  let text = largeResponse ? "Acknowledged. " + ".".repeat(63_500) : "Acknowledged.";
  if (body.model === "gpt-5.6-luna") {
    luna++;
    assert.equal(body.tools?.length || 0, 0, "memory call exposed tools");
    assert.equal(body.text?.format?.type, "json_schema", "memory call omitted its schema");
    assert.equal(body.text.format.strict, true, "memory schema was not strict");
    assert.deepEqual(body.text.format.schema.required, ["checkpoint", "memory"]);
    const consolidation = body.input.flatMap(item => item.content || [])
      .map(item => item.text).filter(text => text?.startsWith("{"))
      .map(text => JSON.parse(text)).find(input => Array.isArray(input.evidence));
    assert(consolidation, "memory call omitted its evidence");
    const indexes = consolidation.evidence.map(row => Number(row.id.split(":").at(-1)));
    assert.deepEqual(indexes, [...new Set(indexes)].sort((a, b) => a - b),
      "memory evidence was duplicated or reordered");
    assert(consolidation.evidence.reduce((sum, row) =>
      sum + [...JSON.stringify(row.item)].length, 0) <= 64_000,
    "memory evidence exceeded its existing character budget");
    if (requiredUserEvidence) {
      assert(consolidation.evidence.some(row => row.item.role === "user" &&
        JSON.stringify(row.item).includes(requiredUserEvidence)),
      "unused evidence capacity did not admit the larger user message");
      requiredUserEvidence = null;
    }
    if (largeResponse) {
      assert(consolidation.evidence.some(row => row.item.role === "user" &&
        JSON.stringify(row.item).includes("Cedar uses port 5823")),
      "large response crowded the user's correction out of memory evidence");
      largeResponse = false;
    }
    sourceId ||= consolidation.evidence[0].id;
    latestSourceId = consolidation.evidence.at(-1).id;
    if (holdMemory) {
      await new Promise(resolve => {
        releaseMemory = resolve;
        memoryReached();
      });
    }
    if (editDuringSave) fs.writeFileSync(memoryFile, "Manual correction: Cedar port 7713.");
    text = malformed ? "INVALID JSON" : JSON.stringify({
      checkpoint: `- [ ] Verify Cedar release [${alteredCheckpointCitation || sourceId}].`,
      memory: memoryText ?? `- Project Cedar uses port 5823; user prefers Celsius [${alteredCitation || sourceId}]. See [deadbeef-topic:detail](./guide.md).\n- Keep memory simple [${renumberUnchangedFact ? "2" : sourceId}].`,
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
  const binary = process.argv[2] ? path.resolve(process.argv[2]) :
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
  await turn(thread, "Remember: project Cedar uses port 5823 and I prefer Celsius. Release verification remains unfinished. " +
    "Keep this correction despite a long response. ".repeat(30));
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
  assert(saved.includes("[1]") && !saved.includes(sourceId), "memory retained long citation IDs");
  const sources = fs.readFileSync(path.join(home, "memories/memory-references/sources.md"), "utf8");
  assert(sources.includes(`| 1 | \`${sourceId}\` |`), "short citation lost its provenance");
  assert.equal(sources.split(sourceId).length - 1, 1, "repeat saving duplicated a reference");
  assert(receipts.every(receipt => receipt.memory === saved && receipt.model_memory.includes(sourceId)),
    "receipt did not distinguish original output from saved memory");
  assert(saved.includes("5823"));

  rpc.dispose();
  thread = await start();
  const nextRequest = requests.length;
  await turn(thread, "What is the Cedar port?");
  assert(JSON.stringify(requests[nextRequest].input).includes(JSON.stringify(saved).slice(1, -1)),
    "restart did not admit saved memory");

  requiredUserEvidence = "LONG_USER_CORRECTION";
  await turn(thread, "LONG_USER_CORRECTION: Cedar still uses port 5823. " + "x".repeat(34_000));

  malformed = true;
  await compact(thread);
  assert.equal(fs.readFileSync(memoryFile, "utf8"), saved, "invalid response changed memory");
  assert(events.some(event => JSON.stringify(event).includes("Memory save failed")),
    "failure was silent");

  malformed = false;
  for (const [destination, citation] of [
    ["memory", sourceId.replace(/:\d+$/, ":9999999")],
    ["memory", sourceId.replaceAll("-", "").replace(/:\d+$/, ":9999999")],
    ["memory", sourceId.replace(/([a-f0-9-]{36})/g, "{$1}").replace(/:\d+$/, ":9999999")],
    ["memory", "01a08a44-2bba-7213-bce0-4a7e-811e-a4be39343ca8:424"],
    ["checkpoint", sourceId.replace(/:\d+$/, ":9999999")],
  ]) {
    alteredCitation = destination === "memory" ? citation : null;
    alteredCheckpointCitation = destination === "checkpoint" ? citation : null;
    const before = {
      checkpoint: fs.readFileSync(checkpointFile, "utf8"),
      sources: fs.readFileSync(path.join(home, "memories/memory-references/sources.md"), "utf8"),
      receipts: fs.readdirSync(receiptDirectory).length,
      events: events.length,
    };
    await compact(thread);
    assert.equal(fs.readFileSync(memoryFile, "utf8"), saved,
      "altered evidence citation changed memory");
    assert.equal(fs.readFileSync(checkpointFile, "utf8"), before.checkpoint);
    assert.equal(fs.readFileSync(path.join(home, "memories/memory-references/sources.md"), "utf8"), before.sources);
    assert.equal(fs.readdirSync(receiptDirectory).length, before.receipts);
    assert(events.slice(before.events).some(event => JSON.stringify(event).includes("unsupported evidence citation")),
      "altered citation failure was silent");
  }
  alteredCitation = null;
  alteredCheckpointCitation = null;
  const sourcesPath = path.join(home, "memories/memory-references/sources.md");
  fs.renameSync(sourcesPath, sourcesPath + ".backup");
  fs.mkdirSync(sourcesPath);
  const beforeSourceFailure = fs.readFileSync(checkpointFile, "utf8");
  const beforeSourceEvents = events.length;
  try {
    await compact(thread);
    assert.equal(fs.readFileSync(memoryFile, "utf8"), saved, "source failure changed memory");
    assert.equal(fs.readFileSync(checkpointFile, "utf8"), beforeSourceFailure,
      "source failure changed checkpoint");
    assert(events.slice(beforeSourceEvents).some(event => JSON.stringify(event).includes("Memory save failed")),
      "source failure was silent");
  } finally {
    fs.rmdirSync(sourcesPath);
    fs.renameSync(sourcesPath + ".backup", sourcesPath);
  }
  const beforeRenumber = {
    checkpoint: fs.readFileSync(checkpointFile, "utf8"),
    receipts: fs.readdirSync(receiptDirectory).length,
    sources: fs.readFileSync(sourcesPath, "utf8"),
    events: events.length,
  };
  renumberUnchangedFact = true;
  await compact(thread);
  assert.equal(fs.readFileSync(memoryFile, "utf8"), saved,
    "unchanged memory fact silently acquired a different citation");
  assert.equal(fs.readFileSync(checkpointFile, "utf8"), beforeRenumber.checkpoint);
  assert.equal(fs.readdirSync(receiptDirectory).length, beforeRenumber.receipts);
  assert.equal(fs.readFileSync(sourcesPath, "utf8"), beforeRenumber.sources);
  assert(events.slice(beforeRenumber.events).some(event =>
    JSON.stringify(event).includes("memory citation changed for unchanged text")));
  renumberUnchangedFact = false;

  memoryText = saved.replace("Keep memory simple", "Keep memory concise");
  await turn(thread, "Correction: the preference is to keep memory concise.");
  assert.equal(fs.readFileSync(memoryFile, "utf8"), memoryText,
    "a factual correction was mistaken for citation renumbering");
  memoryText += "\n- Retry delays [81, 82].";
  await turn(thread, "Cedar retry delays are 81 and 82.");
  memoryText = memoryText.replace("[81, 82]", "[81, 83]");
  await turn(thread, "Correct the second Cedar retry delay to 83.");
  assert.equal(fs.readFileSync(memoryFile, "utf8"), memoryText,
    "ordinary numeric values were mistaken for citations");
  assert.notEqual(latestSourceId, sourceId);
  fs.appendFileSync(sourcesPath, `| 2 | \`${latestSourceId}\` |\n`);
  memoryText = memoryText.replace("Keep memory concise [1]", "Keep memory concise [1, 2]");
  await turn(thread, "The existing preference has additional supporting evidence.");
  assert.equal(fs.readFileSync(memoryFile, "utf8"), memoryText,
    "adding a known supporting citation was rejected");
  memoryText = undefined;

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
    "user corrections survive large responses within the same evidence budget",
    "spare evidence capacity admits user messages above the reserved portion",
    "short stable citations with separate provenance", "source failure preserves notes",
    "renumbered unchanged facts preserve notes and provenance",
    "factual corrections, ordinary numbers and additional known support remain allowed",
    "invented and malformed evidence IDs preserve memory, checkpoint and provenance",
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
