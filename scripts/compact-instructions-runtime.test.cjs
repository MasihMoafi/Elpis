// Real app-server compaction with a loopback-only fake provider. No credentials.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AppServer } = require("../editors/vscode/src/rpc");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-compact-instructions-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
for (const directory of [home, cwd]) fs.mkdirSync(directory);
const instructions = "Preserve unresolved Cedar blockers and exact evidence — ۳ نکته.";
const summaryPrompt = "Summarize the conversation for continuation; preserve unresolved work.";
const requests = [];
let phase = "seed";
let rpc;

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url.endsWith("/responses")) {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ phase, body });
    const id = `response-${requests.length}`;
    // Never echo the instructions into history: later checks detect actual leakage.
    const item = {
      type: "message", id: `message-${id}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Cedar work remains open.", annotations: [] }],
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "response.created", response: { id, status: "in_progress", output: [] } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: {
        id, status: "completed", output: [item],
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  } catch (error) {
    response.destroy(error);
  }
});

async function complete(method, params) {
  let listener;
  let timer;
  const done = new Promise((resolve, reject) => {
    listener = message => {
      if (message.method !== "turn/completed" || message.params.threadId !== params.threadId) return;
      const turn = message.params.turn;
      if (turn?.error || turn?.status === "failed") reject(Error(JSON.stringify(turn)));
      else resolve();
    };
    rpc.on("notification", listener);
    timer = setTimeout(() => reject(Error(`${phase} did not complete`)), 20_000);
  });
  // Attach rejection handling before the RPC, which can itself take time or fail.
  try {
    await Promise.all([rpc.request(method, params), done]);
  } finally {
    clearTimeout(timer);
    rpc.removeListener("notification", listener);
  }
}

function phaseRequests(name) {
  const matches = requests.filter(request => request.phase === name).map(request => request.body);
  assert(matches.length > 0, `${name} never reached the provider`);
  return matches;
}

async function run() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gpt-5.6-terra"', 'model_provider = "fixture"',
    `compact_prompt = ${JSON.stringify(summaryPrompt)}`,
    "[model_providers.fixture]", 'name = "Fixture"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
    'wire_api = "responses"', "requires_openai_auth = false", "",
  ].join("\n"));
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");
  const binary = path.resolve(process.argv[2] || "codex-rs/target/local-release/codex-app-server");
  rpc = new AppServer(binary, cwd, {
    env: { ...process.env, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home },
  });
  rpc.on("request", message => rpc.respond(message.id, { decision: "decline" }));
  await rpc.request("initialize", {
    clientInfo: { name: "compact_instructions_test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized" });
  const { thread } = await rpc.request("thread/start", {
    model: "gpt-5.6-terra", cwd, approvalPolicy: "never", sandbox: "read-only",
  });
  await complete("turn/start", {
    threadId: thread.id, input: [{ type: "text", text: "Cedar needs a follow-up. Acknowledge." }],
  });
  phase = "bare-before";
  await complete("thread/compact/start", { threadId: thread.id });
  const normal = phaseRequests(phase).at(-1);
  assert(JSON.stringify(normal.input).includes(summaryPrompt), "bare compaction lost its summary prompt");
  assert(!String(normal.instructions).includes(instructions), "control already contains test instructions");

  phase = "custom";
  await complete("thread/compact/start", { threadId: thread.id, instructions });
  const custom = phaseRequests(phase).at(-1);
  assert(String(custom.instructions).includes(instructions), "custom compaction instructions never reached the provider");
  assert(String(custom.instructions).startsWith(normal.instructions), "custom instructions replaced normal base guidance");
  assert(JSON.stringify(custom.input).includes(summaryPrompt), "custom compaction replaced the normal summary prompt");

  phase = "bare-after";
  await complete("thread/compact/start", { threadId: thread.id });
  assert.equal(phaseRequests(phase).at(-1).instructions, normal.instructions,
    "custom compaction instructions leaked into later bare compaction");
  phase = "later-turn";
  await complete("turn/start", {
    threadId: thread.id, input: [{ type: "text", text: "Continue normally." }],
  });
  for (const body of phaseRequests(phase)) {
    assert(!String(body.instructions).includes(instructions), "custom instructions leaked into a normal turn");
  }
  console.log(JSON.stringify({ passed: true, checks: [
    "bare compaction retains its normal prompt",
    "exact Unicode instructions reach the local compaction request",
    "custom instructions supplement rather than replace summary guidance",
    "later bare compaction and normal turns do not inherit the instructions",
  ] }, null, 2));
}

run().catch(error => {
  fs.writeFileSync(path.join(root, "failure.txt"), error.stack);
  console.error(error.stack);
  process.exitCode = 1;
}).finally(() => {
  fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(requests, null, 2));
  rpc?.dispose();
  server.closeAllConnections();
  server.close();
  console.error(`Evidence: ${root}`);
});
