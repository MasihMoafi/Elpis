// Network-privacy and TUI-start eval for the elpis-next binary.
//
// usage: node scripts/elpis-next-privacy.test.cjs /absolute/path/to/binary
//
// Every case runs inside `unshare -rn`, a private network namespace with only
// loopback, so nothing can leave the machine. Inside it this script serves a fake
// Responses provider (127.0.0.1:18080) and a logging proxy (127.0.0.1:18888) that
// records every CONNECT or absolute-URI request and refuses it. The binary runs
// under strace so a connection that skips the proxy is also seen.
//
// Cases:
//   exec-defaults   `exec` with only the fake provider configured: must make zero
//                   outside connections and still complete the turn.
//   exec-reenabled  negative control: the same binary with analytics and plugins
//                   switched back on in the user config must show connections.
//   exec-chatgpt    `exec` with a fake (unsigned, never-sent-upstream) ChatGPT
//                   login: must also make zero outside connections.
//   tui-defaults    the TUI starts in a fresh home, exits cleanly on Ctrl+C, and
//                   makes zero outside connections.
//
// ELPIS_PRIVACY_CASES=a,b runs a subset. ELPIS_PRIVACY_EXTRA_CONFIG=<file> appends
// a TOML file to every case's config, to compare a binary without the Elpis
// defaults (for example the pristine upstream build) on equal terms.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const PROVIDER_PORT = 18080;
const PROXY_PORT = 18888;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

const CONFIG = `model = "gpt-5.5"
model_provider = "fake"

[model_providers.fake]
name = "Fake"
base_url = "http://127.0.0.1:${PROVIDER_PORT}/v1"
wire_api = "responses"
requires_openai_auth = false
`;
const REENABLE = `
[analytics]
enabled = true

[features]
plugins = true
`;

const CASES = {
  "exec-defaults": { mode: "exec", config: CONFIG },
  "exec-reenabled": { mode: "exec", config: CONFIG + REENABLE },
  "exec-chatgpt": { mode: "exec", config: CONFIG, chatgptLogin: true },
  "tui-defaults": { mode: "tui", config: CONFIG },
};

// A made-up ChatGPT login: unsigned JWTs with fake ids, fresh so no refresh runs.
function fakeChatgptAuth() {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  const claims = { chatgpt_plan_type: "plus", chatgpt_user_id: "user-EVALFAKE", chatgpt_account_id: "acct-EVALFAKE" };
  const jwt = (payload) => `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.ZmFrZXNpZw`;
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: "eval@example.invalid", exp, "https://api.openai.com/auth": claims }),
      access_token: jwt({ exp, "https://api.openai.com/auth": { ...claims, chatgpt_account_user_id: "user-EVALFAKE__acct-EVALFAKE" } }),
      refresh_token: "rt-EVALFAKE-not-real",
      account_id: "acct-EVALFAKE",
    },
    last_refresh: new Date().toISOString(),
  });
}

function log(file, obj) {
  fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...obj }) + "\n");
}

function sse(res, events) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
}

function startServers(out) {
  let turns = 0;
  const provider = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {}
    const isTitle = Boolean(body?.text?.format?.schema?.required?.includes("title"));
    const tools = (body?.tools || []).map((t) => t.name || t.type);
    log(`${out}/provider.jsonl`, { method: req.method, url: req.url, isTitle });
    if (req.method !== "POST" || !/\/responses$/.test(req.url)) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"error":{"message":"not found"}}');
    }
    if (isTitle) {
      const item = { type: "message", id: "title_1", role: "assistant", content: [{ type: "output_text", text: JSON.stringify({ title: "Eval session" }) }] };
      return sse(res, [
        { type: "response.created", response: { id: "rt" } },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.completed", response: { id: "rt", usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 } } },
      ]);
    }
    turns += 1;
    let item = null;
    if (turns === 1) {
      const name = ["exec_command", "shell_command", "shell"].find((n) => tools.includes(n));
      const args = name === "exec_command" ? { cmd: "echo EVAL_SHELL_OK" } : name === "shell_command" ? { command: "echo EVAL_SHELL_OK" } : { command: ["bash", "-lc", "echo EVAL_SHELL_OK"] };
      if (name) item = { type: "function_call", call_id: "call_1", name, arguments: JSON.stringify(args) };
    }
    if (!item) {
      const sawShellOutput = JSON.stringify(body?.input || []).includes("EVAL_SHELL_OK");
      log(`${out}/provider.jsonl`, { note: "final message", sawShellOutput });
      item = { type: "message", id: `msg_${turns}`, role: "assistant", content: [{ type: "output_text", text: `EVAL_DONE shell_output_seen=${sawShellOutput}` }] };
    }
    const id = `resp_${turns}`;
    const events = [{ type: "response.created", response: { id } }];
    if (item.type === "message") {
      events.push({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
      events.push({ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
    }
    events.push({ type: "response.output_item.done", output_index: 0, item });
    events.push({ type: "response.completed", response: { id, usage: { input_tokens: 500, output_tokens: 20, total_tokens: 520 } } });
    return sse(res, events);
  });
  const proxy = http.createServer((req, res) => {
    log(`${out}/proxy.jsonl`, { kind: "absolute", method: req.method, target: req.url });
    res.writeHead(403);
    res.end("refused by eval proxy");
  });
  proxy.on("connect", (req, socket) => {
    log(`${out}/proxy.jsonl`, { kind: "CONNECT", target: req.url });
    socket.on("error", () => {});
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
  });
  return Promise.all([
    new Promise((resolve) => provider.listen(PROVIDER_PORT, "127.0.0.1", resolve)),
    new Promise((resolve) => proxy.listen(PROXY_PORT, "127.0.0.1", resolve)),
  ]).then(() => [provider, proxy]);
}

function childEnv(out) {
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    LANG: "C.UTF-8",
    HOME: `${out}/fakehome`,
    // The pristine upstream binary reads CODEX_HOME; Elpis reads ELPIS_HOME.
    ELPIS_HOME: `${out}/home`,
    CODEX_HOME: `${out}/home`,
    TMPDIR: `${out}/tmp`,
    RUST_LOG: "warn",
    TERM: "xterm-256color",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) {
    env[key] = PROXY_URL;
  }
  return env;
}

// Drives the TUI through `script`, which gives it a pseudo-terminal. Answers the
// terminal queries the TUI sends at startup, waits for the first frame to settle,
// then presses Ctrl+C twice and waits for a clean exit.
function driveTui(binary, out, env) {
  const inner = `stty rows 40 cols 120; exec ${JSON.stringify(binary)} -C ${JSON.stringify(`${out}/work`)}`;
  const child = spawn("strace", ["-f", "-qq", "-e", "trace=connect,sendto,sendmmsg", "-s", "256", "-o", `${out}/strace.txt`, "script", "-qfec", inner, "/dev/null"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const answers = [
    [/\x1b\[6n/g, "\x1b[1;1R"],
    [/\x1b\]10;\?(\x1b\\|\x07)/g, "\x1b]10;rgb:dddd/dddd/dddd\x1b\\"],
    [/\x1b\]11;\?(\x1b\\|\x07)/g, "\x1b]11;rgb:1111/1111/1111\x1b\\"],
    [/\x1b\[\?u/g, "\x1b[?0u"],
    [/\x1b\[0?c/g, "\x1b[?62;22c"],
  ];
  const transcript = fs.createWriteStream(`${out}/typescript.txt`);
  let pending = "";
  let lastOutput = Date.now();
  let skippedHookReview = false;
  child.stdout.on("data", (data) => {
    transcript.write(data);
    lastOutput = Date.now();
    pending = (pending + data.toString("latin1")).slice(-4096);
    // RTK on PATH can add an untrusted first-run hook. Dismiss its review
    // before exercising the ordinary composer exit path.
    if (!skippedHookReview && pending.includes("Hooks need review")) {
      skippedHookReview = true;
      setTimeout(() => child.stdin.write("\x1b"), 100);
    }
    for (const [pattern, answer] of answers) {
      const matches = pending.match(pattern);
      if (matches) {
        for (let i = 0; i < matches.length; i += 1) child.stdin.write(answer);
        pending = pending.replace(pattern, "");
      }
    }
  });
  child.stderr.on("data", (data) => fs.appendFileSync(`${out}/stderr.txt`, data));
  return new Promise((resolve) => {
    const started = Date.now();
    let sent = 0;
    const timer = setInterval(() => {
      const quiet = Date.now() - lastOutput > 1500;
      if (sent < 2 && Date.now() - started > 4000 && quiet) {
        child.stdin.write("\x03");
        sent += 1;
      }
      if (Date.now() - started > 40_000) child.kill("SIGKILL");
    }, 500);
    child.on("exit", (code, signal) => {
      clearInterval(timer);
      transcript.end();
      resolve({ code, signal, ctrlC: sent });
    });
  });
}

async function inner(caseName, binary, out) {
  const spec = CASES[caseName];
  spawnSync("ip", ["link", "set", "lo", "up"]);
  for (const dir of ["home", "work", "fakehome", "tmp"]) fs.mkdirSync(`${out}/${dir}`, { recursive: true });
  const extra = process.env.ELPIS_PRIVACY_EXTRA_CONFIG ? `\n${fs.readFileSync(process.env.ELPIS_PRIVACY_EXTRA_CONFIG, "utf8")}\n` : "";
  fs.writeFileSync(`${out}/home/config.toml`, `${spec.config}${extra}\n[projects."${out}/work"]\ntrust_level = "trusted"\n`);
  if (spec.chatgptLogin) fs.writeFileSync(`${out}/home/auth.json`, fakeChatgptAuth());
  const servers = await startServers(out);
  const env = childEnv(out);
  let exit;
  if (spec.mode === "exec") {
    exit = await new Promise((resolve) => {
      const child = spawn("strace", ["-f", "-qq", "-e", "trace=connect,sendto,sendmmsg", "-s", "256", "-o", `${out}/strace.txt`, "timeout", "90", binary, "exec", "--skip-git-repo-check", "-C", `${out}/work`, "run echo via the shell tool then answer"], { env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout = [];
      child.stdout.on("data", (d) => stdout.push(d));
      child.stderr.on("data", (d) => fs.appendFileSync(`${out}/stderr.txt`, d));
      child.on("exit", (code, signal) => {
        fs.writeFileSync(`${out}/stdout.txt`, Buffer.concat(stdout));
        resolve({ code, signal });
      });
    });
  } else {
    exit = await driveTui(binary, out, env);
  }
  // Give background tasks a moment to reach the proxy before summarising.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  fs.writeFileSync(`${out}/exit.json`, JSON.stringify(exit));
  for (const server of servers) server.close();
  // Leave nothing running in the namespace.
  const me = fs.readlinkSync("/proc/self/ns/net");
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      if (fs.readlinkSync(`/proc/${entry}/ns/net`) === me) process.kill(Number(entry), "SIGKILL");
    } catch {}
  }
  process.exit(0);
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function summarize(out) {
  const proxied = readJsonl(`${out}/proxy.jsonl`).map((x) => x.target);
  const strace = fs.existsSync(`${out}/strace.txt`) ? fs.readFileSync(`${out}/strace.txt`, "utf8") : "";
  const direct = (strace.match(/connect\(\d+, \{sa_family=AF_INET6?, [^}]*\}/g) || []).filter((line) => !/127\.0\.0\.1|::1|inet_pton\(AF_INET6, "::1"/.test(line));
  const dns = (strace.match(/htons\(53\)/g) || []).length;
  const provider = readJsonl(`${out}/provider.jsonl`);
  const exit = JSON.parse(fs.readFileSync(`${out}/exit.json`, "utf8"));
  const stderr = fs.existsSync(`${out}/stderr.txt`) ? fs.readFileSync(`${out}/stderr.txt`, "utf8") : "";
  const typescript = fs.existsSync(`${out}/typescript.txt`) ? fs.readFileSync(`${out}/typescript.txt`, "latin1") : "";
  return { proxied, direct, dns, provider, exit, stderr, typescript };
}

function outer(binary) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-next-privacy-"));
  const results = [];
  const only = process.env.ELPIS_PRIVACY_CASES ? process.env.ELPIS_PRIVACY_CASES.split(",") : Object.keys(CASES);
  for (const caseName of only) {
    const out = path.join(root, caseName);
    fs.mkdirSync(out, { recursive: true });
    // Root already has namespace privileges; mapping it into a user namespace
    // removes its access to a private checkout owned by the CI runner.
    const namespaceFlags = process.getuid() === 0 ? "-n" : "-rn";
    const r = spawnSync("unshare", [namespaceFlags, process.execPath, __filename, "--inner", caseName, binary, out], { encoding: "utf8", timeout: 180_000 });
    if (r.status !== 0) {
      results.push(`FAIL ${caseName}: harness exited ${r.status}: ${r.stderr}`);
      continue;
    }
    const s = summarize(out);
    const hosts = [...new Set(s.proxied)];
    const detail = `exit=${JSON.stringify(s.exit)} proxied=[${hosts.join(", ")}] direct=${s.direct.length} dns=${s.dns}`;
    try {
      assert.equal(s.direct.length, 0, "a connection skipped the proxy");
      assert.equal(s.dns, 0, "a DNS lookup skipped the proxy");
      if (caseName === "exec-defaults" || caseName === "exec-chatgpt") {
        assert.equal(s.exit.code, 0, `exec failed: ${s.stderr.slice(-400)}`);
        assert(s.provider.some((x) => x.sawShellOutput === true), "the turn did not complete through the fake provider");
        assert.deepEqual(hosts, [], "outside connections with Elpis defaults");
      } else if (caseName === "exec-reenabled") {
        assert(hosts.length > 0, "negative control: re-enabled analytics and plugins made no outside connection");
      } else {
        assert.equal(s.exit.code, 0, `TUI did not exit cleanly: ${s.stderr.slice(-400)}`);
        assert(s.exit.ctrlC >= 1, "the TUI exited before it was asked to");
        assert(!/no complete local package/.test(s.stderr + s.typescript), "the TUI could not start");
        assert(s.typescript.includes(`${out}/work`), "the TUI never drew its session header");
        // The Elpis default is the inline screen, which does not capture the mouse.
        assert(!s.typescript.includes("\x1b[?1000h"), "the TUI captured the mouse");
        assert.deepEqual(hosts, [], "outside connections with Elpis defaults");
      }
      results.push(`ok   ${caseName}: ${detail}`);
    } catch (error) {
      results.push(`FAIL ${caseName}: ${error.message.split("\n")[0]} (${detail})`);
    }
  }
  process.stdout.write(`${results.join("\n")}\nevidence: ${root}\n`);
  if (results.some((line) => line.startsWith("FAIL"))) process.exit(1);
}

if (process.argv[2] === "--inner") {
  inner(process.argv[3], process.argv[4], process.argv[5]).catch((error) => {
    console.error(error);
    process.exit(2);
  });
} else {
  const binary = process.argv[2];
  assert(binary && path.isAbsolute(binary), "usage: node scripts/elpis-next-privacy.test.cjs /absolute/path/to/binary");
  outer(binary);
}
