// Runtime eval for the Elpis provider gateway.
// usage: node scripts/provider-gateway-runtime.test.cjs /absolute/path/to/elpis-next [--drop-completion]
//
// A loopback fake vendor speaks Anthropic Messages and OpenAI-compatible Chat Completions. For
// each protocol, `elpis-next exec` runs one read-and-patch turn: the model reads notes.txt with
// the shell tool, edits it with apply_patch, then answers DONE. The fake records what the
// gateway sent. Everything runs under a fresh temporary home; no real vendor is contacted.
//
// --drop-completion is the negative control: the final vendor stream never completes, so the
// turn must fail instead of being accepted.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const binary = process.argv[2];
const negativeControl = process.argv[3];
assert(binary && path.isAbsolute(binary), "usage: node scripts/provider-gateway-runtime.test.cjs /absolute/path/to/elpis-next [--drop-completion]");
assert(negativeControl === undefined || negativeControl === "--drop-completion",
  "the optional second argument must be --drop-completion");
const dropCompletion = negativeControl === "--drop-completion";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-provider-gateway-"));
const ANTHROPIC_KEY = "fixture-anthropic-key-not-a-real-credential";
const CHAT_KEY = "fixture-chat-key-not-a-real-credential";
const MODEL = "fixture-model";
const PATCH = [
  "*** Begin Patch",
  "*** Update File: notes.txt",
  "@@",
  "-before",
  "+after",
  "*** End Patch",
  "",
].join("\n");

// Every request the fake vendor receives, with the case it belongs to.
const requests = [];
let fixtureFailure;

function sseEvent(response, name, value) {
  response.write(`${name ? `event: ${name}\n` : ""}data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`);
}

// The shell tool and the patch tool as the vendor sees them, whichever schema shape it uses.
function advertisedTools(body, vendor) {
  const tools = (body.tools || []).map(tool => vendor === "anthropic"
    ? { name: tool.name, schema: tool.input_schema }
    : { name: tool.function?.name, schema: tool.function?.parameters });
  const shell = tools.find(tool => tool.name === "exec_command") || tools.find(tool => tool.name === "shell_command");
  const patch = tools.find(tool => tool.name === "apply_patch");
  return { shell, patch };
}

function shellArguments(shell) {
  const properties = shell.schema?.properties || {};
  const field = Object.hasOwn(properties, "cmd") ? "cmd" : "command";
  const args = { [field]: "cat notes.txt" };
  if (Object.hasOwn(properties, "yield_time_ms")) args.yield_time_ms = 10000;
  if (Object.hasOwn(properties, "login")) args.login = false;
  return args;
}

// Which step of the turn a request is: 0 read, 1 patch, 2 answer.
function stage(body, vendor) {
  if (vendor === "anthropic") {
    return (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === "tool_result").length;
  }
  return (body.messages || []).filter(message => message.role === "tool").length;
}

function toolResults(body, vendor) {
  if (vendor === "anthropic") {
    return (body.messages || []).flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === "tool_result").map(block => String(block.content));
  }
  return (body.messages || []).filter(message => message.role === "tool").map(message => String(message.content));
}

function anthropicStream(response, step, tools) {
  sseEvent(response, "message_start", { type: "message_start", message: { id: `msg_${step}`, usage: { input_tokens: 11, output_tokens: 1 } } });
  if (step < 2) {
    const [id, tool, args] = step === 0
      ? ["toolu_read", tools.shell.name, shellArguments(tools.shell)]
      : ["toolu_patch", tools.patch.name, { input: PATCH }];
    const json = JSON.stringify(args);
    const half = Math.floor(json.length / 2);
    sseEvent(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: tool, input: {} } });
    for (const part of [json.slice(0, half), json.slice(half)]) {
      sseEvent(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: part } });
    }
    sseEvent(response, "content_block_stop", { type: "content_block_stop", index: 0 });
    sseEvent(response, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 5 } });
    sseEvent(response, "message_stop", { type: "message_stop" });
    return;
  }
  sseEvent(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  sseEvent(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE" } });
  sseEvent(response, "content_block_stop", { type: "content_block_stop", index: 0 });
  sseEvent(response, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } });
  if (!dropCompletion) sseEvent(response, "message_stop", { type: "message_stop" });
}

function chatStream(response, step, tools) {
  if (step < 2) {
    const [id, tool, args] = step === 0
      ? ["call_read", tools.shell.name, shellArguments(tools.shell)]
      : ["call_patch", tools.patch.name, { input: PATCH }];
    const json = JSON.stringify(args);
    const half = Math.floor(json.length / 2);
    sseEvent(response, "", { id: `chat_${step}`, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: tool, arguments: json.slice(0, half) } }] } }] });
    sseEvent(response, "", { id: `chat_${step}`, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: json.slice(half) } }] }, finish_reason: "tool_calls" }] });
  } else {
    sseEvent(response, "", { id: "chat_2", choices: [{ index: 0, delta: { content: "DONE" } }] });
    sseEvent(response, "", { id: "chat_2", choices: [{ index: 0, delta: {}, finish_reason: dropCompletion ? null : "stop" }] });
  }
  sseEvent(response, "", { id: `chat_${step}`, choices: [], usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 } });
  sseEvent(response, "", "[DONE]");
}

const server = http.createServer((request, response) => { void (async () => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const vendor = request.url.startsWith("/anthropic/") ? "anthropic" : request.url.startsWith("/chat/") ? "chat" : null;
  const record = { vendor, method: request.method, url: request.url, headers: request.headers };
  requests.push(record);
  const turnPath = vendor === "anthropic" ? "/anthropic/v1/messages" : "/chat/v1/chat/completions";
  if (request.method !== "POST" || request.url !== turnPath) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `fixture has no ${request.method} ${request.url}` } }));
    return;
  }
  if (vendor === "anthropic") {
    assert.equal(request.headers["x-api-key"], ANTHROPIC_KEY, "Anthropic request lacks its key");
    assert.equal(request.headers["anthropic-version"], "2023-06-01");
    assert.equal(request.headers.authorization, undefined, "Anthropic received a bearer token");
  } else {
    assert.equal(request.headers.authorization, `Bearer ${CHAT_KEY}`, "Chat request lacks its key");
  }
  const body = JSON.parse(raw);
  record.body = body;
  const tools = advertisedTools(body, vendor);
  // Side requests (titles, memory) carry no shell tool; answer them plainly and set them apart.
  if (!tools.shell || body.model !== MODEL) {
    record.side = true;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (vendor === "anthropic") {
      sseEvent(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "{\"title\":\"Fixture\"}" } });
      sseEvent(response, "content_block_stop", { type: "content_block_stop", index: 0 });
      sseEvent(response, "message_stop", { type: "message_stop" });
    } else {
      sseEvent(response, "", { choices: [{ index: 0, delta: { content: "{\"title\":\"Fixture\"}" }, finish_reason: "stop" }] });
      sseEvent(response, "", "[DONE]");
    }
    response.end();
    return;
  }
  assert(tools.patch, `${vendor} request did not advertise apply_patch as a function`);
  record.stage = stage(body, vendor);
  response.writeHead(200, { "content-type": "text/event-stream" });
  if (vendor === "anthropic") anthropicStream(response, record.stage, tools);
  else chatStream(response, record.stage, tools);
  response.end();
})().catch(error => {
  fixtureFailure ||= error;
  if (!response.headersSent) response.writeHead(500);
  response.end();
}); });

function catalogModel(slug) {
  return {
    slug,
    display_name: slug,
    description: "gateway fixture",
    supported_reasoning_levels: [],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority: 0,
    availability_nux: null,
    upgrade: null,
    model_messages: { instructions_template: "You are a coding agent. Use the tools you are given." },
    supports_reasoning_summary_parameter: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: "freeform",
    truncation_policy: { mode: "bytes", limit: 10000 },
    context_window: 200000,
    experimental_supported_tools: [],
    input_modalities: ["text"],
  };
}

// Runs the binary without blocking the event loop the fake vendor needs.
function run(args, options, timeoutMs) {
  return new Promise(resolve => {
    const child = spawn(binary, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", error => { clearTimeout(timer); resolve({ status: null, error, stdout, stderr }); });
    child.on("close", status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

async function runCase(vendor, port) {
  const caseRoot = path.join(root, vendor);
  const home = path.join(caseRoot, "elpis-home");
  const cwd = path.join(caseRoot, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "notes.txt"), "before\n");
  const catalog = path.join(caseRoot, "models.json");
  fs.writeFileSync(catalog, JSON.stringify({ models: [catalogModel(MODEL)] }));
  const [providerId, wire, envKey, prefix] = vendor === "anthropic"
    ? ["fixture-anthropic", "anthropic_messages", "FIXTURE_ANTHROPIC_API_KEY", "anthropic"]
    : ["fixture-chat", "chat", "FIXTURE_CHAT_API_KEY", "chat"];
  fs.writeFileSync(path.join(home, "config.toml"), [
    `model = "${MODEL}"`,
    `model_provider = "${providerId}"`,
    `model_catalog_json = ${JSON.stringify(catalog)}`,
    "",
    `[model_providers.${providerId}]`,
    `name = "Fixture ${vendor}"`,
    `base_url = "http://127.0.0.1:${port}/${prefix}/v1"`,
    `env_key = "${envKey}"`,
    `wire_api = "${wire}"`,
    "request_max_retries = 0",
    "stream_max_retries = 0",
    "",
  ].join("\n"));
  const lastMessage = path.join(caseRoot, "last-message.txt");
  const start = requests.length;
  const result = await run([
    "exec",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--output-last-message", lastMessage,
    "Read notes.txt, change before to after, then reply DONE.",
  ], {
    cwd,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: caseRoot,
      ELPIS_HOME: home,
      TMPDIR: caseRoot,
      RUST_LOG: "error",
      [envKey]: vendor === "anthropic" ? ANTHROPIC_KEY : CHAT_KEY,
    },
  }, 120_000);
  fs.writeFileSync(path.join(caseRoot, "stdout.log"), result.stdout || "");
  fs.writeFileSync(path.join(caseRoot, "stderr.log"), result.stderr || "");
  const received = requests.slice(start);
  const turns = received.filter(record => !record.side && record.body);
  const note = fs.readFileSync(path.join(cwd, "notes.txt"), "utf8");
  const last = fs.existsSync(lastMessage) ? fs.readFileSync(lastMessage, "utf8").trim() : null;
  const summary = {
    vendor,
    status: result.status,
    turnRequests: turns.length,
    sideRequests: received.filter(record => record.side).length,
    paths: [...new Set(received.map(record => `${record.method} ${record.url}`))],
    note: note.trim(),
    lastMessage: last,
    stderrTail: (result.stderr || "").trim().split("\n").slice(-5),
  };
  console.log(JSON.stringify(summary));

  if (fixtureFailure) throw fixtureFailure;
  assert(!result.error, `elpis-next did not start: ${result.error?.message}`);
  assert.equal(turns.length, 3, `${vendor}: expected read, patch and answer requests (see ${caseRoot})`);
  assert.deepEqual(turns.map(record => record.stage), [0, 1, 2], `${vendor}: turn steps out of order`);
  assert(toolResults(turns[1].body, vendor).some(text => text.includes("before")),
    `${vendor}: the shell output did not reach the vendor`);
  assert.equal(note, "after\n", `${vendor}: apply_patch did not edit the file`);
  for (const record of received) {
    assert.equal(record.body?.input, undefined, `${vendor}: a Responses body reached the vendor`);
    assert(!Object.keys(record.headers).some(name => name.startsWith("x-elpis-")),
      `${vendor}: gateway routing headers reached the vendor`);
  }
  if (dropCompletion) {
    assert.notEqual(result.status, 0, `${vendor}: an incomplete final stream was accepted`);
    assert.notEqual(last, "DONE", `${vendor}: an incomplete answer was reported as the result`);
  } else {
    assert.equal(result.status, 0, `${vendor}: exec failed (see ${caseRoot}/stderr.log)`);
    assert.equal(last, "DONE", `${vendor}: the final answer did not arrive`);
  }
  return summary;
}

// A config naming a built-in gateway provider loads, and with no key the gateway refuses before
// any request leaves. A dead proxy catches any outbound attempt, so no real vendor is reached.
// With `viaFlag`, the provider comes from `--provider` instead of config.toml.
async function builtInCase(providerId, model, envKey, viaFlag = false) {
  const caseRoot = path.join(root, providerId);
  const home = path.join(caseRoot, "elpis-home");
  const cwd = path.join(caseRoot, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(home, "config.toml"),
    `model = "${model}"\n${viaFlag ? "" : `model_provider = "${providerId}"\n`}`);
  const result = await run([
    ...(viaFlag ? ["--provider", providerId] : []),
    "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", "Say hi.",
  ], {
    cwd,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: caseRoot,
      ELPIS_HOME: home,
      TMPDIR: caseRoot,
      RUST_LOG: "error",
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
    },
  }, 60_000);
  const output = `${result.stdout}\n${result.stderr}`;
  fs.writeFileSync(path.join(caseRoot, "output.log"), output);
  const summary = {
    provider: providerId,
    viaFlag,
    status: result.status,
    notFound: output.includes(`Model provider \`${providerId}\` not found`),
    refusedForKey: output.includes(`no API key for provider \`${providerId}\``),
    namesVariable: output.includes(envKey),
  };
  console.log(JSON.stringify(summary));
  assert(!summary.notFound, `${providerId}: the built-in provider is missing (see ${caseRoot}/output.log)`);
  assert(summary.refusedForKey && summary.namesVariable,
    `${providerId}: expected the gateway's missing-key refusal naming ${envKey} (see ${caseRoot}/output.log)`);
  assert.notEqual(result.status, 0);
  return summary;
}

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const results = [];
  for (const vendor of ["anthropic", "chat"]) results.push(await runCase(vendor, port));
  results.push(await builtInCase("anthropic", "claude-sonnet-4-6", "ANTHROPIC_API_KEY"));
  results.push(await builtInCase("google-gemini", "gemini-3.5-flash", "GEMINI_API_KEY", true));
  console.log(JSON.stringify({ passed: true, mode: dropCompletion ? "drop-completion" : "positive", results }));
})().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(requests, null, 2));
  console.log(`Evidence: ${root}`);
  server.closeAllConnections();
  server.close();
});
