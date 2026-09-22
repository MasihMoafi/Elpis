// Loopback diagnostic for empty-Enter's interrupt -> next-turn backend path.
// Does not measure keyboard routing, TUI redraw, terminal I/O or real-provider latency.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { AppServer } = require("../editors/vscode/src/rpc");

const binary = path.resolve(process.argv[2] || "codex-rs/target/local-release/codex-app-server");
const injectDelay = process.argv.includes("--delay-delivery");
const compilerActive = process.argv.includes("--compiler-active");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-queued-delivery-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
fs.mkdirSync(home);
fs.mkdirSync(cwd);
const samples = [];
let rpc;
let providerArrival;
let phase = "blocked";
let requestCount = 0;
const notifications = [];

function boundedSignal(label) {
  let resolve;
  let timer;
  const promise = new Promise((accept, reject) => {
    resolve = value => { clearTimeout(timer); accept(value); };
    timer = setTimeout(() => reject(Error(`${label} timed out`)), 10_000);
  });
  // Main run still awaits the original rejection; avoid an early unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, cancel: () => clearTimeout(timer) };
}

const server = http.createServer(async (request, response) => {
  if (!request.url.endsWith("/responses")) {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requestCount += 1;
  const id = `response-${requestCount}`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({
    type: "response.created", response: { id, status: "in_progress", output: [] },
  })}\n\n`);
  providerArrival?.resolve({ at: performance.now(), body });
  if (phase === "blocked") return; // Deliberately never finish; cancellation must work.
  const item = {
    type: "message", id: `message-${id}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Follow-up received.", annotations: [] }],
  };
  for (const event of [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: {
      id, status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
    } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});

function nextCompletion(threadId) {
  const signal = boundedSignal("turn completion");
  const listener = event => {
    if (event.method === "turn/completed" && event.params.threadId === threadId) {
      signal.resolve({ at: performance.now(), turn: event.params.turn });
    }
  };
  rpc.on("notification", listener);
  return { ...signal, cancel: () => {
    signal.cancel();
    rpc.removeListener("notification", listener);
  } };
}

async function run() {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  fs.writeFileSync(path.join(home, "config.toml"), [
    'model = "gpt-5.6-terra"', 'model_provider = "fixture"',
    "[model_providers.fixture]", 'name = "Fixture"',
    `base_url = "http://127.0.0.1:${server.address().port}/v1"`,
    'wire_api = "responses"', "requires_openai_auth = false", "",
  ].join("\n"));
  fs.writeFileSync(path.join(home, "hooks.json"), "{}");
  rpc = new AppServer(binary, cwd, {
    env: { ...process.env, CODEX_HOME: home, CODEX_AUTH_HOME: home, ELPIS_HOME: home },
  });
  rpc.on("notification", event => {
    notifications.push({ at: performance.now(), method: event.method });
  });
  rpc.on("request", event => rpc.respond(event.id, { decision: "decline" }));
  await rpc.request("initialize", {
    clientInfo: { name: "queued_delivery_test", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.send({ method: "initialized" });

  // Fixed fresh-thread fixtures; first sample is warm-up, ten recorded samples.
  for (let iteration = -1; iteration < 10; iteration += 1) {
    const { thread } = await rpc.request("thread/start", {
      model: "gpt-5.6-terra", cwd, approvalPolicy: "never", sandbox: "read-only",
    });
    await rpc.request("thread/name/set", { threadId: thread.id, name: "Queue fixture" });
    phase = "blocked";
    providerArrival = boundedSignal("blocked provider request");
    const { turn } = await rpc.request("turn/start", {
      threadId: thread.id, input: [{ type: "text", text: "Start the blocking fixture." }],
    });
    await providerArrival.promise;
    const interrupted = nextCompletion(thread.id);
    const started = performance.now();
    await rpc.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    const acknowledged = performance.now();
    const terminal = await interrupted.promise;
    interrupted.cancel();
    assert.equal(terminal.turn.status, "interrupted");

    // Negative control recreates a stalled handoff without changing provider work.
    if (injectDelay) await new Promise(resolve => setTimeout(resolve, 300));
    phase = "follow-up";
    providerArrival = boundedSignal("follow-up provider request");
    const completed = nextCompletion(thread.id);
    await rpc.request("turn/start", {
      threadId: thread.id, input: [{ type: "text", text: "Queued Cedar follow-up." }],
    });
    const arrival = await providerArrival.promise;
    assert(JSON.stringify(arrival.body).includes("Queued Cedar follow-up."));
    assert.equal((await completed.promise).turn.status, "completed");
    completed.cancel();
    if (iteration >= 0) samples.push({
      interruptEventMs: terminal.at - started,
      interruptAckMs: acknowledged - started,
      deliveryMs: arrival.at - started,
    });
  }
  const sorted = samples.map(sample => sample.deliveryMs).sort((a, b) => a - b);
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const result = { binary, injectDelay, compilerActive, samples, p95Ms, budgetMs: 250,
    recordedAt: new Date().toISOString(),
    environment: { node: process.version, platform: process.platform,
      kernel: os.release(), cpu: os.cpus()[0]?.model, loadAverage: os.loadavg() },
    scope: "Loopback interrupt-ack + next-turn provider arrival, not TUI or live-provider latency" };
  fs.writeFileSync(path.join(root, "measurements.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  assert(p95Ms <= 250, `backend queued delivery p95 ${p95Ms.toFixed(1)}ms exceeds 250ms`);
}

run().catch(error => {
  fs.writeFileSync(path.join(root, "failure.txt"), error.stack);
  console.error(error.stack);
  process.exitCode = 1;
}).finally(() => {
  providerArrival?.cancel();
  fs.writeFileSync(path.join(root, "notifications.json"), JSON.stringify(notifications, null, 2));
  rpc?.dispose();
  server.closeAllConnections();
  server.close();
  console.error(`Evidence: ${root}`);
});
