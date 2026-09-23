const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AppServer } = require("../editors/vscode/src/rpc");

const negativeControl = process.argv[3];
assert(
  negativeControl === undefined || negativeControl === "--drop-completion",
  "optional third argument must be --drop-completion",
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-chat-runtime-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
fs.mkdirSync(home);
fs.mkdirSync(cwd);

const fixtureToken = "fixture-chat-token-not-a-real-credential";
const requests = [];
const paths = [];
let mode = "positive";
let rpc;
let rejectCase;
let fixtureFailure;

function writeEvent(response, value) {
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

function advertisedCommand(body) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const candidates = tools
    .filter(tool => tool.type === "function" && tool.function)
    .map(tool => tool.function);
  const selected = candidates.find(tool => tool.name === "exec_command")
    || candidates.find(tool => tool.name === "shell_command");
  assert(selected, "Chat request did not advertise exec_command or shell_command");
  const properties = selected.parameters?.properties || {};
  const commandField = Object.hasOwn(properties, "cmd") ? "cmd"
    : Object.hasOwn(properties, "command") ? "command" : null;
  assert(commandField, `${selected.name} schema has no native command field`);
  const args = { [commandField]: "printf CHAT_TOOL_OK" };
  if (Object.hasOwn(properties, "login")) args.login = false;
  if (Object.hasOwn(properties, "yield_time_ms")) args.yield_time_ms = 10000;
  if (Object.hasOwn(properties, "timeout_ms")) args.timeout_ms = 2000;
  return { name: selected.name, arguments: JSON.stringify(args), commandField };
}

function beginSse(response) {
  response.writeHead(200, { "content-type": "text/event-stream" });
}

function finishSse(response) {
  response.write("data: [DONE]\n\n");
  response.end();
}

const server = http.createServer((request, response) => { void (async () => {
  paths.push(request.url);
  if (request.url !== "/v1/chat/completions") {
    response.writeHead(404);
    response.end();
    return;
  }
  assert.equal(
    request.headers.authorization,
    `Bearer ${fixtureToken}`,
    "Chat provider did not use its isolated fixture credential",
  );
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const record = { mode, url: request.url, body };
  requests.push(record);
  beginSse(response);

  if (mode !== "positive") {
    writeEvent(response, {
      id: `chat-${mode}`,
      choices: [{ index: 0, delta: { content: "PARTIAL_SHOULD_FAIL" } }],
    });
    if (mode === "truncated-done") response.write("data: [DONE]\n\n");
    response.end();
    return;
  }

  const toolResult = body.messages?.find(message =>
    message.role === "tool" && message.tool_call_id === "chat-tool-call");
  if (!toolResult) {
    const selected = advertisedCommand(body);
    record.tool = selected;
    writeEvent(response, {
      id: "chat-positive-tool",
      choices: [{ index: 0, delta: { tool_calls: [{
        index: 0,
        id: "chat-tool-call",
        type: "function",
        function: { name: selected.name, arguments: selected.arguments },
      }] } }],
    });
    writeEvent(response, {
      id: "chat-positive-tool",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    finishSse(response);
    return;
  }

  assert.match(String(toolResult.content), /CHAT_TOOL_OK/, "tool output did not return to Chat");
  writeEvent(response, {
    id: "chat-positive-final",
    choices: [{ index: 0, delta: { content: "DONE" } }],
  });
  writeEvent(response, {
    id: "chat-positive-final",
    choices: [{
      index: 0,
      delta: {},
      finish_reason: negativeControl === "--drop-completion" ? null : "stop",
    }],
    usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
  });
  finishSse(response);
  })().catch(error => {
    fixtureFailure ||= error;
    if (!response.headersSent) response.writeHead(500);
    response.end();
    rejectCase?.(new Error(`fixture server failed: ${fixtureFailure.message}`, {
      cause: fixtureFailure,
    }));
  });
});

async function runTurn(caseMode) {
  mode = caseMode;
  const start = requests.length;
  const { thread } = await rpc.request("thread/start", {
    model: "gpt-5.4",
    cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });
  await rpc.request("thread/name/set", {
    threadId: thread.id,
    name: `Chat loopback ${caseMode}`,
  });
  const events = [];
  let listener;
  let timer;
  const done = new Promise((resolve, reject) => {
    listener = event => {
      if (event.params?.threadId !== thread.id) return;
      events.push(event);
      if (event.method === "turn/completed") resolve(event.params);
    };
    rpc.on("notification", listener);
    timer = setTimeout(() => reject(Error(`turn timed out: ${caseMode}`)), 20000);
  });
  const fixtureFailed = new Promise((_, reject) => {
    rejectCase = reject;
    if (fixtureFailure) reject(new Error(`fixture server failed: ${fixtureFailure.message}`, {
      cause: fixtureFailure,
    }));
  });
  let completed;
  try {
    await rpc.request("turn/start", {
      threadId: thread.id,
      input: [{ type: "text", text: "Run the advertised command and finish with DONE." }],
    });
    completed = await Promise.race([done, fixtureFailed]);
  } finally {
    rejectCase = undefined;
    clearTimeout(timer);
    rpc.removeListener("notification", listener);
  }
  const calls = requests.slice(start);
  const assistantItems = events.filter(event =>
    event.method === "item/completed" && event.params?.item?.type === "agentMessage");

  if (caseMode === "positive") {
    assert.equal(completed.turn.status, "completed", "complete Chat stream failed");
    assert.equal(completed.turn.error, null, "complete Chat stream returned an error");
    assert.equal(calls.length, 2, "tool roundtrip did not use exactly two Chat requests");
    assert.equal(calls[0].tool.commandField,
      calls[0].tool.name === "exec_command" ? "cmd" : "command");
    assert(assistantItems.some(event => event.params.item.text === "DONE"),
      "successful Chat reply did not complete with DONE");
    const usage = events.filter(event => event.method === "thread/tokenUsage/updated").at(-1);
    assert(usage, "Chat usage was not mapped to the app-server stream");
    assert.equal(usage.params.tokenUsage.last.totalTokens, 11,
      "final Chat usage did not reach the app-server stream");
  } else {
    assert.equal(completed.turn.status, "failed", `${caseMode} stream was accepted`);
    assert(completed.turn.error, `${caseMode} stream failed without an error`);
    assert.equal(calls.length, 1, `${caseMode} stream was retried or continued`);
    assert.equal(assistantItems.length, 0, `${caseMode} emitted a successful assistant completion`);
  }
  return {
    mode: caseMode,
    status: completed.turn.status,
    requests: calls.length,
    assistantCompletions: assistantItems.length,
  };
}

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gpt-5.4"',
    'model_provider = "fixture-chat"',
    '[model_providers.fixture-chat]',
    'name = "Fixture Chat"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
    'env_key = "FIXTURE_CHAT_API_KEY"',
    'wire_api = "chat"',
    'request_max_retries = 0',
    'stream_max_retries = 0',
    'requires_openai_auth = false',
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");

  const binary = path.resolve(process.argv[2]
    || path.resolve(__dirname, "../codex-rs/target/local-release/codex-app-server"));
  rpc = new AppServer(binary, cwd, {
    args: path.basename(binary) === "elpis" ? ["app-server"] : [],
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME: home,
      CODEX_AUTH_HOME: home,
      ELPIS_HOME: home,
      FIXTURE_CHAT_API_KEY: fixtureToken,
    },
  });
  rpc.child.stderr.on("data", data => fs.appendFileSync(path.join(root, "stderr.log"), data));
  rpc.on("disconnect", () => {});
  rpc.on("request", event => rpc.respond(event.id, { decision: "decline" }));
  await rpc.request("initialize", {
    clientInfo: { name: "chat_loopback_fixture", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized" });

  const results = [];
  for (const caseMode of ["positive", "truncated-eof", "truncated-done"]) {
    const result = await runTurn(caseMode);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  assert(paths.every(requestPath => requestPath === "/v1/chat/completions"),
    "fixture observed a non-Chat provider request");
  console.log(JSON.stringify({ passed: true, root, results }));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(requests, null, 2));
  console.log(`Evidence: ${root}`);
  rpc?.dispose();
  server.closeAllConnections();
  server.close();
});
