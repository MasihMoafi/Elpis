import type { ChildProcessWithoutNullStreams } from 'node:child_process';
type RpcResult = { thread: { id: string } };
type Waiter = { resolve(value: RpcResult): void; reject(error: Error): void; timer: NodeJS.Timeout };
type WireMessage = { id: string | number; method: string; params: { threadId?: string }; result: RpcResult; error?: unknown };
type RequestItem = { role?: string; content?: string | { text?: string }[] };
type ProviderRequest = { stage: string; body: { input?: RequestItem[]; [key: string]: unknown } };
// Ledger admission eval: admitted sources reach the provider, and withdrawals append
// notices while earlier context stays in the request until compaction.
// usage: ELPIS_BIN=/abs/elpis-next node scripts/continuity-admission-runtime.test.cts
//    or: ELPIS_APP_SERVER_BIN=/abs/codex-app-server node scripts/continuity-admission-runtime.test.cts
// Runs only against a loopback fake provider with a fresh temporary home; wrap it in
// `unshare -rn sh -c "ip link set lo up; ..."` to rule out any other network access.
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const crypto: typeof import("node:crypto") = require("node:crypto");
const { EventEmitter }: typeof import("node:events") = require("node:events");
const fs: typeof import("node:fs") = require("node:fs");
const http: typeof import("node:http") = require("node:http");
const os: typeof import("node:os") = require("node:os");
const path: typeof import("node:path") = require("node:path");
const readline: typeof import("node:readline") = require("node:readline");
const { spawn }: typeof import("node:child_process") = require("node:child_process");

const MEMORY_SENTINEL = "ELPIS_MEMORY_SENTINEL_9bf259b96d";
const GLOBAL_AGENTS_SENTINEL = "ELPIS_GLOBAL_AGENTS_SENTINEL_934fc08c8a";
const PROJECT_AGENTS_SENTINEL = "ELPIS_PROJECT_AGENTS_SENTINEL_13a0a94236";
const DEV_RULE_SENTINEL = "ELPIS_DEV_RULE_SENTINEL_841c87ce04";
const ADDED_FILE_SENTINEL = "ELPIS_ADDED_FILE_SENTINEL_5f0d2c71e3";
const GOAL_SENTINEL = "ELPIS_GOAL_SENTINEL_c61e0b7a24";
const CHECKPOINT_SENTINEL = "ELPIS_CHECKPOINT_SENTINEL_2d9f4a13b8";
const USER_SENTINEL = "ELPIS_NEIGHBOR_USER_SENTINEL_a329510b8e";
const DEVELOPER_SENTINEL = "ELPIS_NEIGHBOR_DEVELOPER_SENTINEL_786ed03a7f";
const AGENTS_WITHDRAWAL = "The user withdrew these AGENTS.md instructions";
const CONTINUITY_UPDATE = "## Elpis Admitted Context: update";
const NEGATIVE_CONTROLS = new Set([
  "disable-memory-on-admission",
  "disable-agents-on-admission",
  "disable-dev-on-admission",
  "disable-added-on-admission",
  "disable-continuity-on-admission",
]);
const REQUEST_TIMEOUT_MS = 30_000;
const STAGES = ["default", "off", "on", "withdrawn", "malformed"];

// ELPIS_BIN is the elpis multitool, run as `<bin> app-server`; ELPIS_APP_SERVER_BIN is a
// standalone app-server binary such as v0.3.0's codex-app-server.
const multitoolInput = process.env.ELPIS_BIN;
const appServerInput = process.env.ELPIS_APP_SERVER_BIN;
assert(
  Boolean(multitoolInput) !== Boolean(appServerInput),
  "set exactly one of ELPIS_BIN (multitool) or ELPIS_APP_SERVER_BIN (standalone app-server)",
);
const binaryInput = multitoolInput || appServerInput;
const binaryArgs = multitoolInput ? ["app-server"] : [];
assert(binaryInput && path.isAbsolute(binaryInput), "the binary under test must be an absolute path");
const binary = path.resolve(binaryInput);
assert(fs.statSync(binary).isFile(), `the binary under test is not a file: ${binary}`);

const negativeControl = process.env.ELPIS_CONTINUITY_NEGATIVE_CONTROL;
assert(
  negativeControl === undefined || NEGATIVE_CONTROLS.has(negativeControl),
  `ELPIS_CONTINUITY_NEGATIVE_CONTROL must be one of ${[...NEGATIVE_CONTROLS].join(", ")} when set`,
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
const devRules = path.join(root, "dev-rules");
const devRuleName = "RUNTIME.md";
const addedFile = path.join(cwd, "NOTES.md");
for (const directory of [cwd, workspace, path.dirname(memoryFile), devRules]) {
  fs.mkdirSync(directory, { recursive: true });
}
fs.writeFileSync(memoryFile, `# Elpis Memory\n\n- ${MEMORY_SENTINEL}\n`);
fs.writeFileSync(path.join(home, "AGENTS.md"), `${GLOBAL_AGENTS_SENTINEL}\n`);
fs.writeFileSync(path.join(cwd, "AGENTS.md"), `${PROJECT_AGENTS_SENTINEL}\n`);
fs.writeFileSync(path.join(devRules, devRuleName), `${DEV_RULE_SENTINEL}\n`);
fs.writeFileSync(addedFile, `${ADDED_FILE_SENTINEL}\n`);
// `/add` stores the canonical path as a custom source key.
const addedSourceKey = JSON.stringify(fs.realpathSync(addedFile));
fs.writeFileSync(path.join(home, "hooks.json"), "{}");

class AppServer extends EventEmitter {
  declare closed: boolean;
  declare nextId: number;
  declare pending: Map<string, Waiter>;
  declare child: ChildProcessWithoutNullStreams;
  declare stderr: string;
  constructor(executable: string, args: string[], workingDirectory: string, env: NodeJS.ProcessEnv) {
    super();
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.child = spawn(executable, args, {
      cwd: workingDirectory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.child.stderr.on("data", chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-16_384);
    });
    this.child.on("error", error => {
      for (const waiter of this.pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(Error(`could not start app-server: ${(error as Error).message}`));
      }
      this.pending.clear();
      if (!this.closed) this.emit("unexpectedExit", error);
    });
    readline.createInterface({ input: this.child.stdout }).on("line", line => {
      let message: WireMessage;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.emit("protocolError", Error(`invalid app-server JSON: ${(error as Error).message}`));
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

  write(message: object) {
    assert(!this.closed, "cannot write to a closed app-server");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  send(message: object) {
    this.write(message);
  }

  respond(id: string | number, result: object) {
    this.write({ id, result });
  }

  request(method: string, params: object) {
    const id = this.nextId++;
    return new Promise<RpcResult>((resolve, reject) => {
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
    await new Promise<void>(resolve => {
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

let rpc: AppServer;
let activeStage: string | undefined;
let providerFailure: Error | undefined;
const requests: ProviderRequest[] = [];

function sendEvents(response: import('node:http').ServerResponse, id: string) {
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
  if (!activeStage || requests.at(-1)?.stage === activeStage) {
    providerFailure = Error(
      activeStage
        ? `auxiliary provider request arrived during ${activeStage}`
        : "provider request arrived without an active test stage",
    );
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: providerFailure.message }));
    return;
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

function occurrenceCount(value: unknown, sentinel: string) {
  return JSON.stringify(value).split(sentinel).length - 1;
}

function messageText(item: { content?: string | { text?: string }[] }) {
  return typeof item.content === "string" ? item.content
    : (item.content || []).map(part => part.text || "").join("\n");
}

async function complete(threadId: string, text: string) {
  let listener: ((message: WireMessage) => void) | undefined;
  let exitListener: ((error: Error) => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve, reject) => {
    listener = (message: WireMessage) => {
      if (message.method === "turn/completed" && message.params?.threadId === threadId) resolve();
    };
    exitListener = (error: Error) => reject(error);
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
    if (listener) rpc.removeListener("notification", listener);
    if (exitListener) rpc.removeListener("unexpectedExit", exitListener);
  }
}

async function runStage(threadId: string, stage: string, admission: string | null, text: string) {
  if (negativeControl === "disable-memory-on-admission" && stage === "on") {
    assert(admission !== null); admission = admission.replace("memory = true", "memory = false");
  }
  if (negativeControl === "disable-agents-on-admission" && stage === "on") {
    assert(admission !== null); admission = admission
      .replace("global_rules = true", "global_rules = false")
      .replace("project_rules = true", "project_rules = false");
  }
  if (negativeControl === "disable-dev-on-admission" && stage === "withdrawn") {
    assert(admission !== null); admission = admission.replace(`"${devRuleName}" = true`, `"${devRuleName}" = false`);
  }
  if (negativeControl === "disable-added-on-admission" && stage === "on") {
    assert(admission !== null); admission = admission.replace(`${addedSourceKey} = true`, `${addedSourceKey} = false`);
  }
  if (negativeControl === "disable-continuity-on-admission" && stage === "on") {
    assert(admission !== null); admission = admission.replace("goal = true", "goal = false").replace("checkpoint = true", "checkpoint = false");
  }
  if (admission === null) fs.rmSync(admissionFile, { force: true });
  else fs.writeFileSync(admissionFile, admission);
  activeStage = stage;
  const before = requests.length;
  try {
    await complete(threadId, text);
  } finally {
    activeStage = undefined;
  }
  if (providerFailure) throw providerFailure;
  assert.equal(requests.length, before + 1, `${stage} turn made an auxiliary or missing provider request`);
  const latest = requests.at(-1); assert(latest);
  assert.equal(latest.stage, stage, `${stage} provider request was misattributed`);
}

function observe() {
  return requests.map(({ stage, body }) => ({
    stage,
    memorySentinelCount: occurrenceCount(body, MEMORY_SENTINEL),
    globalAgentsSentinelCount: occurrenceCount(body, GLOBAL_AGENTS_SENTINEL),
    projectAgentsSentinelCount: occurrenceCount(body, PROJECT_AGENTS_SENTINEL),
    devRuleSentinelCount: occurrenceCount(body, DEV_RULE_SENTINEL),
    addedFileSentinelCount: occurrenceCount(body, ADDED_FILE_SENTINEL),
    goalSentinelCount: occurrenceCount(body, GOAL_SENTINEL),
    checkpointSentinelCount: occurrenceCount(body, CHECKPOINT_SENTINEL),
    userSentinelCount: occurrenceCount(body, USER_SENTINEL),
    developerSentinelCount: occurrenceCount(body, DEVELOPER_SENTINEL),
    agentsWithdrawalCount: occurrenceCount(body, AGENTS_WITHDRAWAL),
    continuityUpdateCount: occurrenceCount(body, CONTINUITY_UPDATE),
  }));
}

async function run() {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address(); assert(address && typeof address !== "string");
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gpt-5.6-terra"',
    'model_provider = "fixture"',
    "[model_providers.fixture]",
    'name = "Fixture"',
    `base_url = "http://127.0.0.1:${address.port}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "[skills]",
    `dev_rule_roots = [${JSON.stringify(devRules)}]`,
    "",
  ].join("\n"));

  rpc = new AppServer(binary, binaryArgs, cwd, childEnvironment());
  rpc.on("request", (message: WireMessage) => rpc.respond(message.id, { decision: "decline" }));
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
  const threadDir = path.join(workspace, "threads", thread);
  fs.mkdirSync(threadDir, { recursive: true });
  fs.writeFileSync(path.join(threadDir, "GOAL.md"), `# Elpis Goal\n\n- Thread: \`${thread}\`\n\n## Objective\n\n${GOAL_SENTINEL}\n`);
  fs.writeFileSync(path.join(threadDir, "ES.md"), `# Elpis Session Checkpoint\n\n- Thread: \`${thread}\`\n\n## Latest Result\n\n${CHECKPOINT_SENTINEL}\n`);

  await runStage(
    thread,
    "default",
    null,
    `Keep this unrelated user fact in history: ${USER_SENTINEL}`,
  );
  await runStage(thread, "off", "memory = false\n", "Admission is explicitly off.");
  await runStage(thread, "on", [
    "memory = true",
    "goal = true",
    "checkpoint = true",
    "global_rules = true",
    "project_rules = true",
    "[dev_sources]",
    `"${devRuleName}" = false`,
    "[custom_sources]",
    `${addedSourceKey} = true`,
    "",
  ].join("\n"), "Memory, AGENTS and the added file are on while the dev rule is off.");
  await runStage(thread, "withdrawn", [
    "memory = false",
    "goal = false",
    "checkpoint = false",
    "global_rules = false",
    "project_rules = false",
    "[dev_sources]",
    `"${devRuleName}" = true`,
    "[custom_sources]",
    `${addedSourceKey} = false`,
    "",
  ].join("\n"), "AGENTS and the added file were withdrawn and the dev rule was restored.");
  await runStage(thread, "malformed", "memory = [\n", "Malformed admission must fail closed.");

  assert.equal(requests.length, STAGES.length, "unexpected auxiliary provider request count");
  assert.deepEqual(requests.map(entry => entry.stage), STAGES, "provider request stages changed");
  for (const { stage, body } of requests) {
    const expectedContinuityCount = ["on", "withdrawn", "malformed"].includes(stage) ? 1 : 0;
    const expectedDevRuleCount = ["withdrawn", "malformed"].includes(stage) ? 2 : 1;
    assert.equal(
      occurrenceCount(body, MEMORY_SENTINEL),
      expectedContinuityCount,
      `${stage} request had the wrong MEMORY sentinel count`,
    );
    assert.equal(
      occurrenceCount(body, GLOBAL_AGENTS_SENTINEL),
      1,
      `${stage} request had the wrong global AGENTS sentinel count`,
    );
    assert.equal(
      occurrenceCount(body, PROJECT_AGENTS_SENTINEL),
      1,
      `${stage} request had the wrong project AGENTS sentinel count`,
    );
    assert.equal(
      occurrenceCount(body, DEV_RULE_SENTINEL),
      expectedDevRuleCount,
      `${stage} request had the wrong dev-rule sentinel count`,
    );
    assert.equal(
      occurrenceCount(body, ADDED_FILE_SENTINEL),
      expectedContinuityCount,
      `${stage} request had the wrong added-file sentinel count`,
    );
    // GOAL and ES, like MEMORY and the added file, remain in history once admitted.
    for (const [name, sentinel] of [["GOAL", GOAL_SENTINEL], ["ES", CHECKPOINT_SENTINEL]] as const) {
      assert.equal(
        occurrenceCount(body, sentinel),
        expectedContinuityCount,
        `${stage} request had the wrong ${name} sentinel count`,
      );
    }
    assert.match(JSON.stringify(body), new RegExp(DEVELOPER_SENTINEL), `${stage} lost developer context`);
    assert.equal(
      occurrenceCount(body, AGENTS_WITHDRAWAL),
      ["withdrawn", "malformed"].includes(stage) ? 1 : 0,
      `${stage} request had the wrong AGENTS withdrawal note count`,
    );
    assert.equal(
      occurrenceCount(body, CONTINUITY_UPDATE),
      { default: 0, off: 0, on: 1, withdrawn: 2, malformed: 3 }[stage],
      `${stage} request had the wrong continuity update count`,
    );
  }
  const appendedDeveloperText = new Map<string, string>();
  for (let index = 1; index < requests.length; index++) {
    const entry = requests[index], previous = requests[index - 1];
    assert(entry && previous, `missing request at index ${index}`);
    const { stage, body } = entry;
    const previousInput = previous.body.input;
    assert(Array.isArray(previousInput) && Array.isArray(body.input), `${stage} request has no input array`);
    assert.deepEqual(
      body.input.slice(0, previousInput.length),
      previousInput,
      `${stage} request changed the previous input instead of appending to it`,
    );
    assert.match(JSON.stringify(body), new RegExp(USER_SENTINEL), `${stage} lost neighboring user history`);
    const appended = body.input.slice(previousInput.length);
    appendedDeveloperText.set(stage, appended
      .filter(item => item.role === "developer")
      .map(messageText)
      .join("\n"));
    if (stage === "withdrawn") {
      const text = appended.filter(item => item.role === "user").map(messageText).join("\n");
      assert(
        text.includes(AGENTS_WITHDRAWAL) && text.includes("Do not follow the AGENTS.md instructions given earlier"),
        "withdrawn did not instruct the model to ignore the earlier AGENTS.md instructions",
      );
    }
  }

  // Withdrawal notices tell the model to ignore the named historical text.
  for (const [stage, paths] of [
    ["on", [path.join(devRules, devRuleName)]],
    ["withdrawn", [memoryFile, path.join(threadDir, "GOAL.md"), path.join(threadDir, "ES.md"), addedFile]],
    ["malformed", [path.join(devRules, devRuleName)]],
  ] as const) {
    const text = appendedDeveloperText.get(stage);
    assert(text !== undefined, `${stage} did not record appended developer text`);
    assert(text.includes(CONTINUITY_UPDATE), `${stage} did not append a continuity update`);
    assert(text.includes("ignore their earlier text"), `${stage} did not instruct the model to ignore withdrawn sources`);
    for (const source of paths) {
      assert(text.split("\n").includes(`- ${source}`), `${stage} did not name withdrawn source ${source}`);
    }
  }

  const observations = observe();
  fs.writeFileSync(path.join(root, "observations.json"), JSON.stringify(observations, null, 2));
  console.log(JSON.stringify({
    passed: true,
    binary,
    providerRequestCount: requests.length,
    observations,
    checks: [
      "MEMORY is absent by default and while explicitly disabled",
      "GOAL and ES are absent by default and appended once when enabled",
      "MEMORY is admitted exactly once when enabled",
      "withdrawals append notices naming the affected sources; earlier text stays until compaction",
      "malformed admission withdraws the remaining admitted dev rule",
      "global and project AGENTS are admitted by default, then withdrawn with a note",
      "the configured dev rule is admitted by default, withdrawn, and appended again when restored",
      "a file added with /add is appended when included and named when withdrawn",
      "neighboring user and developer context and the full request prefix survive changes",
      "one provider request occurs per turn with no auxiliary request",
    ],
  }, null, 2));
}

async function cleanup() {
  await rpc?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

run().catch((error: Error) => {
  fs.writeFileSync(path.join(root, "failure.txt"), error.stack || String(error));
  fs.writeFileSync(path.join(root, "requests.json"), JSON.stringify(requests, null, 2));
  console.error(error.stack || error);
  console.error(JSON.stringify({ passed: false, observations: observe() }, null, 2));
  process.exitCode = 1;
}).finally(async () => {
  try {
    await cleanup();
  } catch (error) {
    console.error(`cleanup failed: ${(error as Error).stack || error}`);
    process.exitCode = 1;
  }
  if (process.exitCode || process.env.ELPIS_CONTINUITY_KEEP_EVIDENCE === "1") {
    console.error(`Evidence: ${root}`);
  } else {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
