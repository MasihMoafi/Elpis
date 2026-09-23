const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const MEMORY_SENTINEL = "ELPIS_MEMORY_SENTINEL_9bf259b96d";
const USER_SENTINEL = "ELPIS_NEIGHBOR_USER_SENTINEL_a329510b8e";
const DEVELOPER_SENTINEL = "ELPIS_NEIGHBOR_DEVELOPER_SENTINEL_786ed03a7f";
const NEGATIVE_CONTROL = "drop-admitted-sentinel";
const REQUEST_TIMEOUT_MS = 30_000;
const STAGES = ["default", "off", "on", "withdrawn", "malformed"];

const binaryInput = process.env.ELPIS_APP_SERVER_BIN;
assert(binaryInput, "ELPIS_APP_SERVER_BIN must name the app-server binary under test");
assert(path.isAbsolute(binaryInput), "ELPIS_APP_SERVER_BIN must be an absolute path");
const binary = path.resolve(binaryInput);
assert(fs.statSync(binary).isFile(), `ELPIS_APP_SERVER_BIN is not a file: ${binary}`);

const negativeControl = process.env.ELPIS_CONTINUITY_NEGATIVE_CONTROL;
assert(
  negativeControl === undefined || negativeControl === NEGATIVE_CONTROL,
  `ELPIS_CONTINUITY_NEGATIVE_CONTROL must be ${NEGATIVE_CONTROL} when set`,
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-continuity-admission-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
const workspace = path.join(
  home,
  "context/workspaces",
  "project-" + crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12),
);
const memoryFile = path.join(home, "memories/MEMORY.md");
const admissionFile = path.join(workspace, "admission.toml");
for (const directory of [cwd, workspace, path.dirname(memoryFile)]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(memoryFile, `# Elpis Memory\n\n- ${MEMORY_SENTINEL}\n`);
fs.writeFileSync(path.join(home, "hooks.json"), "{}");

class AppServer extends EventEmitter {
  constructor(executable, workingDirectory, env) {
    super();
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.child = spawn(executable, [], {
      cwd: workingDirectory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-16_384);
    });
    readline.createInterface({ input: this.child.stdout }).on("line", line => {
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit("protocolError", Error(`invalid app-server JSON: ${error.message}`));
        return;
      }
      if (Object.hasOwn(message, "id") && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
        const waiter = this.pending.get(String(message.id));
        if (!waiter) return;
        this.pending.delete(String(message.id));
        clearTimeout(waiter.timer);
        if (message.error) waiter.reject(Error(`app-server error: ${JSON.stringify(message.error)}`));
        else waiter.resolve(message.result);
      } else if (Object.hasOwn(message, "id")) {
        this.emit("request", message);
      } else {
        this.emit("notification", message);
      }
    });
    this.child.on("exit", (code, signal) => {
      const error = Error(
        `app-server exited before shutdown (code=${code}, signal=${signal})\n${this.stderr}`,
      );
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
      this.pending.clear();
      if (!this.closed) this.emit("unexpectedExit", error);
    });
  }

  write(message) {
    assert(!this.closed, "cannot write to a closed app-server");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  send(message) {
    this.write(message);
  }

  respond(id, result) {
    this.write({ id, result });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(Error(`app-server request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(String(id), { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

let rpc;
let activeStage;
const requests = [];

function sendEvents(response, id) {
  const item = {
    type: "message",
    id: `message-${id}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: "Fixture response.", annotations: [] }],
  };
  const events = [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id,
        status: "completed",
        output: [item],
        usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
}

const server = http.createServer(async (request, response) => {
  if (!request.url?.includes("/responses")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }

  let raw = "";
  for await (const chunk of request) raw += chunk;
  assert(activeStage, "provider request arrived without an active test stage");
  if (negativeControl === NEGATIVE_CONTROL && activeStage === "on") {
    raw = raw.replaceAll(MEMORY_SENTINEL, "ELPIS_DROPPED_MEMORY_SENTINEL");
  }
  const body = JSON.parse(raw);
  requests.push({ stage: activeStage, body });
  sendEvents(response, `fixture-${requests.length}`);
});
server.requestTimeout = 10_000;
server.headersTimeout = 10_000;

function childEnvironment() {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    USER: "elpis-eval",
    LOGNAME: "elpis-eval",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: root,
    CODEX_HOME: home,
    CODEX_AUTH_HOME: home,
    ELPIS_HOME: home,
    RUST_LOG: "error",
  };
}

function occurrenceCount(value, sentinel) {
  return JSON.stringify(value).split(sentinel).length - 1;
}

async function complete(threadId, text) {
  let listener;
  let exitListener;
  let timer;
  const done = new Promise((resolve, reject) => {
    listener = message => {
      if (message.method === "turn/completed" && message.params?.threadId === threadId) resolve();
    };
    exitListener = error => reject(error);
    rpc.on("notification", listener);
    rpc.once("unexpectedExit", exitListener);
    timer = setTimeout(() => reject(Error(`turn did not complete during ${activeStage}`)), REQUEST_TIMEOUT_MS);
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
    rpc.removeListener("unexpectedExit", exitListener);
  }
}

async function runStage(threadId, stage, admission, text) {
  if (admission === null) fs.rmSync(admissionFile, { force: true });
  else fs.writeFileSync(admissionFile, admission);
  activeStage = stage;
  const before = requests.length;
  await complete(threadId, text);
  assert.equal(requests.length, before + 1, `${stage} turn made an auxiliary or missing provider request`);
  assert.equal(requests.at(-1).stage, stage, `${stage} provider request was misattributed`);
}

async function run() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
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

  rpc = new AppServer(binary, cwd, childEnvironment());
  rpc.on("request", message => rpc.respond(message.id, { decision: "decline" }));
  await rpc.request("initialize", {
    clientInfo: { name: "elpis_continuity_admission_runtime_test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized" });
  const thread = (await rpc.request("thread/start", {
    model: "gpt-5.6-terra",
    cwd,
    approvalPolicy: "never",
    sandbox: "read-only",
    developerInstructions: `Keep this unrelated instruction: ${DEVELOPER_SENTINEL}`,
  })).thread.id;
  await rpc.request("thread/name/set", { threadId: thread, name: "Continuity admission eval" });

  await runStage(
    thread,
    "default",
    null,
    `Keep this unrelated user fact in history: ${USER_SENTINEL}`,
  );
  await runStage(thread, "off", "memory = false\n", "Admission is explicitly off.");
  await runStage(thread, "on", "memory = true\n", "Admission is now on.");
  await runStage(thread, "withdrawn", "memory = false\n", "Admission was withdrawn.");
  await runStage(thread, "malformed", "memory = [\n", "Malformed admission must fail closed.");

  assert.equal(requests.length, STAGES.length, "unexpected auxiliary provider request count");
  assert.deepEqual(requests.map(entry => entry.stage), STAGES, "provider request stages changed");
  for (const { stage, body } of requests) {
    const expectedMemoryCount = stage === "on" ? 1 : 0;
    assert.equal(
      occurrenceCount(body, MEMORY_SENTINEL),
      expectedMemoryCount,
      `${stage} request had the wrong MEMORY sentinel count`,
    );
    assert.match(JSON.stringify(body), new RegExp(DEVELOPER_SENTINEL), `${stage} lost developer context`);
  }
  for (const stage of ["off", "on", "withdrawn", "malformed"]) {
    const body = requests.find(entry => entry.stage === stage).body;
    assert.match(JSON.stringify(body), new RegExp(USER_SENTINEL), `${stage} lost neighboring user history`);
  }

  const observations = requests.map(({ stage, body }) => ({
    stage,
    memorySentinelCount: occurrenceCount(body, MEMORY_SENTINEL),
    userSentinelCount: occurrenceCount(body, USER_SENTINEL),
    developerSentinelCount: occurrenceCount(body, DEVELOPER_SENTINEL),
  }));
  fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify({
    passed: true,
    binary,
    providerRequestCount: requests.length,
    observations,
    checks: [
      "MEMORY is absent by default and while explicitly disabled",
      "MEMORY is admitted exactly once when enabled",
      "disabling admission removes MEMORY on the next turn in the same thread",
      "malformed admission fails closed",
      "neighboring user and developer context survives slot replacement",
      "one provider request occurs per turn with no auxiliary request",
    ],
  }, null, 2));
}

async function cleanup() {
  await rpc?.close();
  await new Promise(resolve => server.close(resolve));
}

run().catch(error => {
  fs.writeFileSync(path.join(root, "failure.txt"), error.stack || String(error));
  fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(requests, null, 2));
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await cleanup();
  } catch (error) {
    console.error(`cleanup failed: ${error.stack || error}`);
    process.exitCode = 1;
  }
  if (process.exitCode || process.env.ELPIS_CONTINUITY_KEEP_EVIDENCE === "1") {
    console.error(`Evidence: ${root}`);
  } else {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
