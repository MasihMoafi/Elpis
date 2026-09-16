// Background maintenance on a non-OpenAI provider, end to end.
//
// Memory saving and session naming used to be pinned to a model that only
// exists on OpenAI, and structured output was only ever attached to Responses
// requests. This drives a real app-server against a chat-protocol fixture and
// asserts both halves: the background work reaches the configured model, and it
// arrives carrying a strict JSON schema rather than as free-form prose.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { AppServer } = require("../editors/vscode/src/rpc");

const BACKGROUND_MODEL = "deepseek/deepseek-v4.1-flash";
const MAIN_MODEL = "some-main-model";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-background-model-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
const workspace = path.join(
  home,
  "context/workspaces",
  "project-" + crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12),
);
const memoryFile = path.join(home, "memories/MEMORY.md");
for (const directory of [cwd, workspace, path.dirname(memoryFile)]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(path.join(workspace, "memory-autosave.json"), '{"enabled":true}');
fs.writeFileSync(path.join(workspace, "admission.toml"), "memory = true\ncheckpoint = true\n");

const requests = [];
let rpc;

function schemaOf(body) {
  return body.response_format?.json_schema;
}

function sse(response, text) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  const id = "chatcmpl-" + requests.length;
  for (const event of [
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: text } }] },
    { id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ]) {
    response.write("data: " + JSON.stringify(event) + "\n\n");
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

const server = http.createServer(async (request, response) => {
  if (!request.url.includes("/chat/completions")) {
    response.writeHead(404);
    response.end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);

  const required = schemaOf(body)?.schema?.required ?? [];
  if (required.includes("title")) {
    sse(response, JSON.stringify({ title: "Background model routing" }));
    return;
  }
  if (required.includes("checkpoint")) {
    sse(
      response,
      JSON.stringify({ checkpoint: "Verify background routing.", memory: "- Port is 5823." }),
    );
    return;
  }
  sse(response, "Acknowledged.");
});

const turn = async (threadId, text) => {
  let listener;
  const done = new Promise(resolve => {
    listener = message => {
      if (message.method === "turn/completed" && message.params.threadId === threadId) resolve();
    };
    rpc.on("notification", listener);
  });
  let timer;
  try {
    await rpc.request("turn/start", { threadId, input: [{ type: "text", text }] });
    await Promise.race([
      done,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("turn never completed")), 20000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    rpc.removeListener("notification", listener);
  }
};

async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(message);
}

(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(
    path.join(home, "config.toml"),
    [
      `model = "${MAIN_MODEL}"`,
      'model_provider = "fixture"',
      `background_model = "${BACKGROUND_MODEL}"`,
      "[model_providers.fixture]",
      'name = "Fixture"',
      `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
      'wire_api = "chat"',
      "requires_openai_auth = false",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");

  rpc = new AppServer(
    path.resolve(
      process.argv[2] ||
        path.resolve(__dirname, "../codex-rs/target/local-release/codex-app-server"),
    ),
    home,
    { env: { ...process.env, ELPIS_HOME: home, CODEX_HOME: home, CODEX_AUTH_HOME: home } },
  );
  rpc.on("disconnect", () => {});
  await rpc.request("initialize", {
    clientInfo: { name: "background_model_test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized" });

  const { thread } = await rpc.request("thread/start", {
    cwd,
    model: MAIN_MODEL,
    approvalPolicy: "never",
    sandbox: "read-only",
  });
  await turn(thread.id, "Remember that the project uses port 5823.");

  const main = requests.filter(body => !schemaOf(body));
  assert(main.length >= 1, "the user's turn never reached the provider");
  assert.equal(main[0].model, MAIN_MODEL, "the user's turn must keep the main model");

  await until(
    () => requests.some(body => schemaOf(body)?.schema?.required?.includes("checkpoint")),
    "no memory save arrived",
  );
  const save = requests.find(body =>
    schemaOf(body)?.schema?.required?.includes("checkpoint"),
  );
  assert.equal(save.model, BACKGROUND_MODEL, "the saver ignored background_model");
  assert.equal(schemaOf(save).strict, true, "the saver's schema was not strict");
  assert.equal(schemaOf(save).schema.additionalProperties, false);

  await until(
    () => requests.some(body => schemaOf(body)?.schema?.required?.includes("title")),
    "no session naming arrived",
  );
  const title = requests.find(body => schemaOf(body)?.schema?.required?.includes("title"));
  assert.equal(title.model, BACKGROUND_MODEL, "naming ignored background_model");
  assert.equal(schemaOf(title).strict, true, "the naming schema was not strict");

  await until(() => fs.existsSync(memoryFile), "memory was never written");
  assert.match(fs.readFileSync(memoryFile, "utf8"), /5823/);

  // The receipt is the audit trail for what actually ran, so it must name the
  // model that did the work rather than a hardcoded default.
  const receiptDir = path.join(workspace, "memory-saves");
  await until(
    () => fs.existsSync(receiptDir) && fs.readdirSync(receiptDir).length > 0,
    "no save receipt was written",
  );
  const receipt = JSON.parse(
    fs.readFileSync(path.join(receiptDir, fs.readdirSync(receiptDir).sort().at(-1)), "utf8"),
  );
  assert.equal(receipt.model, BACKGROUND_MODEL, "the receipt misreports the model");

  console.log(
    JSON.stringify(
      {
        passed: true,
        background_model: BACKGROUND_MODEL,
        checks: [
          "the user's turn keeps the main model",
          "memory saving uses background_model on a chat provider",
          "session naming uses background_model on a chat provider",
          "both carry a strict json schema on the chat wire",
          "the saved memory reaches MEMORY.md",
          "the save receipt names the model that ran",
        ],
      },
      null,
      2,
    ),
  );
})()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    rpc?.dispose();
    server.close();
    server.closeAllConnections();
  });
