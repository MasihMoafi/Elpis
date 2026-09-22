const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AppServer } = require("../editors/vscode/src/rpc");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-agent-memory-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
const workspace = path.join(
  home,
  "context/workspaces",
  "project-" + crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12),
);
const memoryFile = path.join(home, "memories/MEMORY.md");
const checkpointFile = path.join(workspace, "ES.md");
const settingsFile = path.join(workspace, "memory-autosave.json");
for (const directory of [cwd, workspace, path.dirname(memoryFile)]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(settingsFile, '{"enabled":true}');
// Saving is enabled while admission is deliberately off for the first turn.
fs.writeFileSync(path.join(workspace, "admission.toml"), "memory = false\ncheckpoint = true\n");
fs.writeFileSync(memoryFile, "# Elpis Memory\n\n- Preserve this existing preference.\n");
fs.writeFileSync(checkpointFile, "# Elpis Session Checkpoint\n\n## Consolidated State\n\n- Existing work.\n");

let rpc;
let requestCount = 0;
let sawMemoryTool = false;
let sawMemoryToolOutput = false;
let auxiliaryRequestCount = 0;
let mode = "save";
let admissionOffHidMemory = false;
let admissionOnLoadedMemory = false;
let disabledHidTool = false;
const requests = [];

function send(response, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write("data: " + JSON.stringify(event) + "\n\n");
  response.end();
}

function completed(id, output) {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output,
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
    },
  };
}

function assistantEvents(id, text) {
  const item = {
    type: "message",
    id: `message-${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    completed(id, [item]),
  ];
}

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
  requestCount += 1;
  if (body.text?.format?.schema?.required?.includes("checkpoint")) {
    auxiliaryRequestCount += 1;
  }
  const tool = body.tools?.find(candidate => candidate.name === "save_memory");
  sawMemoryTool ||= Boolean(tool);
  const serialized = JSON.stringify(body);
  if (mode === "save") {
    admissionOffHidMemory = !serialized.includes("Preserve this existing preference");
  } else if (mode === "observe-off") {
    admissionOffHidMemory &&= !serialized.includes("User prefers Celsius");
    send(response, assistantEvents(`response-${requestCount}`, "Admission remained off."));
    return;
  } else if (mode === "observe-on") {
    admissionOnLoadedMemory = serialized.includes("User prefers Celsius");
    send(response, assistantEvents(`response-${requestCount}`, "Admission is on."));
    return;
  } else if (mode === "disabled") {
    disabledHidTool = !tool;
    send(response, assistantEvents(`response-${requestCount}`, "Saving is disabled."));
    return;
  }
  const output = body.input?.find(item =>
    item.type === "function_call_output" && item.call_id === "save-memory-1");
  if (output) {
    sawMemoryToolOutput = true;
    send(response, assistantEvents(`response-${requestCount}`, "Saved by the responding agent."));
    return;
  }
  if (tool) {
    const item = {
      type: "function_call",
      call_id: "save-memory-1",
      name: "save_memory",
      arguments: JSON.stringify({
        memory_edits: [{ old_text: null, new_text: "- User prefers Celsius.\n" }],
        checkpoint: "- [ ] Verify Cedar on port 5823.",
      }),
    };
    const id = `response-${requestCount}`;
    send(response, [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      completed(id, [item]),
    ]);
    return;
  }
  send(response, assistantEvents(`response-${requestCount}`, "No memory tool was available."));
});

async function complete(threadId, text) {
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
    await rpc.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    });
    await done;
  } finally {
    clearTimeout(timer);
    rpc.removeListener("notification", listener);
  }
}

async function run() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gpt-5.6-terra"',
    'model_provider = "fixture"',
    "[model_providers.fixture]",
    'name = "Fixture"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");
  const binary = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, "../codex-rs/target/local-release/codex-app-server");
  rpc = new AppServer(binary, cwd, {
    env: { ...process.env, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home },
  });
  rpc.on("request", message => rpc.respond(message.id, { decision: "decline" }));
  await rpc.request("initialize", {
    clientInfo: { name: "elpis_agent_memory_test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized" });
  const thread = (await rpc.request("thread/start", {
    model: "gpt-5.6-terra",
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
  })).thread.id;

  await complete(thread, "I prefer Celsius. Continue project Cedar on port 5823.");
  assert(sawMemoryTool, "responding agent was not offered save_memory");
  assert(sawMemoryToolOutput, "save_memory did not run in the responding agent's tool loop");
  assert.equal(auxiliaryRequestCount, 0, "a separate memory-consolidation request still ran");
  assert(fs.readFileSync(memoryFile, "utf8").includes("User prefers Celsius"));
  assert(!fs.readFileSync(memoryFile, "utf8").includes("Cedar"), "project state leaked into global memory");
  assert(fs.readFileSync(checkpointFile, "utf8").includes("Verify Cedar on port 5823"));
  assert(admissionOffHidMemory, "saving opt-in implicitly enabled memory admission");

  mode = "observe-off";
  const offThread = (await rpc.request("thread/start", {
    model: "gpt-5.6-terra", cwd, approvalPolicy: "never", sandbox: "read-only",
  })).thread.id;
  await complete(offThread, "What durable preferences do you know?");
  assert(admissionOffHidMemory, "saved memory was admitted while admission remained off");

  fs.writeFileSync(path.join(workspace, "admission.toml"), "memory = true\ncheckpoint = true\n");
  mode = "observe-on";
  const onThread = (await rpc.request("thread/start", {
    model: "gpt-5.6-terra", cwd, approvalPolicy: "never", sandbox: "read-only",
  })).thread.id;
  await complete(onThread, "What durable preferences do you know?");
  assert(admissionOnLoadedMemory, "saved memory was not admitted after admission was enabled");

  fs.writeFileSync(settingsFile, '{"enabled":false}');
  mode = "disabled";
  const disabledThread = (await rpc.request("thread/start", {
    model: "gpt-5.6-terra", cwd, approvalPolicy: "never", sandbox: "read-only",
  })).thread.id;
  await complete(disabledThread, "Do not save this turn.");
  assert(disabledHidTool, "save_memory remained available after saving was disabled");

  console.log(JSON.stringify({
    passed: true,
    checks: [
      "responding agent owns the save_memory call",
      "guarded memory and checkpoint files are persisted",
      "no auxiliary memory request runs",
      "saving and admission remain independent",
      "disabled saving removes the tool",
    ],
  }, null, 2));
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
