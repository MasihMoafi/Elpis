const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

const binaryInput = process.argv[2];
assert(binaryInput, "usage: node scripts/elpis-home-isolation.test.cjs /absolute/path/to/elpis [--drop-elpis-home]");
assert(path.isAbsolute(binaryInput), "binary path must be absolute");
const binary = path.resolve(binaryInput);
assert(fs.statSync(binary).isFile(), `binary is not a file: ${binary}`);

const control = process.argv[3];
assert(
  control === undefined || control === "--drop-elpis-home",
  "only --drop-elpis-home is accepted after the binary path",
);

const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-home-isolation-"));
const observations = {
  binary,
  control: control || null,
  startedAt: new Date().toISOString(),
  timeoutMs: TIMEOUT_MS,
  cases: [],
};

function mkdir(directory) {
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function snapshot(target) {
  if (!fs.existsSync(target)) return null;
  const entries = [];
  function visit(current, relative) {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      entries.push({ path: relative, type: "symlink", target: fs.readlinkSync(current) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: "directory", mode: stat.mode & 0o777 });
      for (const name of fs.readdirSync(current).sort()) {
        visit(path.join(current, name), relative ? path.join(relative, name) : name);
      }
      return;
    }
    const bytes = fs.readFileSync(current);
    entries.push({
      path: relative,
      type: "file",
      mode: stat.mode & 0o777,
      size: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  }
  visit(target, ".");
  return entries;
}

function isDirectory(target) {
  return fs.existsSync(target) && fs.statSync(target).isDirectory();
}

function childEnvironment(home, extra = {}) {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: home,
    USER: "elpis-home-eval",
    LOGNAME: "elpis-home-eval",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: evidenceRoot,
    RUST_LOG: "error",
    ...extra,
  };
}

function runCase(name, cwd, home, extraEnv = {}) {
  const started = Date.now();
  const result = spawnSync(binary, ["--help"], {
    cwd,
    env: childEnvironment(home, extraEnv),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const observation = {
    name,
    cwd,
    home,
    extraEnv,
    status: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
  observations.cases.push(observation);
  assert.notEqual(result.error?.code, "ETIMEDOUT", `${name} timed out`);
  assert(!result.error, `${name} failed to start: ${result.error?.message}`);
  assert.equal(result.signal, null, `${name} exited by signal ${result.signal}`);
  assert(Number.isInteger(result.status), `${name} did not report an exit status`);
  return observation;
}

function writeSentinel(directory, text) {
  mkdir(directory);
  fs.writeFileSync(path.join(directory, "sentinel"), text);
}

function run() {
  const defaultHome = mkdir(path.join(evidenceRoot, "default-home"));
  const defaultCwd = mkdir(path.join(evidenceRoot, "default-cwd"));
  const defaultRun = runCase("default", defaultCwd, defaultHome);
  defaultRun.filesystem = {
    elpis: snapshot(path.join(defaultHome, ".elpis")),
    codex: snapshot(path.join(defaultHome, ".codex")),
  };
  assert.equal(defaultRun.status, 0, `default --help failed: ${defaultRun.stderr}`);
  assert(isDirectory(path.join(defaultHome, ".elpis")), "default startup did not create HOME/.elpis");
  assert(!fs.existsSync(path.join(defaultHome, ".codex")), "default startup unexpectedly created HOME/.codex");

  const customHome = mkdir(path.join(evidenceRoot, "custom-home"));
  const customCwd = mkdir(path.join(evidenceRoot, "custom-cwd"));
  const fixtureCodex = path.join(customHome, ".codex");
  writeSentinel(fixtureCodex, "do not change fixture Codex data\n");
  const customHomeBefore = snapshot(customHome);
  const codexBefore = snapshot(fixtureCodex);
  const customRelative = "relative-elpis-home";
  const customEnv = control === "--drop-elpis-home" ? {} : { ELPIS_HOME: customRelative };
  const customRun = runCase("custom-relative", customCwd, customHome, customEnv);
  const codexAfter = snapshot(fixtureCodex);
  customRun.filesystem = {
    expectedElpis: snapshot(path.join(customCwd, customRelative)),
    homeBefore: customHomeBefore,
    homeAfter: snapshot(customHome),
    codexBefore,
    codexAfter,
  };
  assert.equal(customRun.status, 0, `custom --help failed: ${customRun.stderr}`);
  assert(
    isDirectory(path.join(customCwd, customRelative)),
    "relative ELPIS_HOME was not resolved against cwd",
  );
  assert.deepEqual(customRun.filesystem.homeAfter, customHomeBefore, "custom startup changed HOME");
  assert.deepEqual(codexAfter, codexBefore, "custom startup changed fixture .codex data");

  const invalidHome = mkdir(path.join(evidenceRoot, "invalid-home"));
  const invalidCwd = mkdir(path.join(evidenceRoot, "invalid-cwd"));
  const invalidCodex = path.join(invalidHome, ".codex");
  writeSentinel(invalidCodex, "preserve invalid-case Codex data\n");
  const invalidTarget = path.join(invalidCwd, "elpis-home-is-a-file");
  fs.writeFileSync(invalidTarget, "preserve invalid target bytes\n");
  const invalidCwdBefore = snapshot(invalidCwd);
  const invalidHomeBefore = snapshot(invalidHome);
  const invalidCodexBefore = snapshot(invalidCodex);
  const invalidRun = runCase("invalid-file", invalidCwd, invalidHome, {
    ELPIS_HOME: invalidTarget,
  });
  const invalidCwdAfter = snapshot(invalidCwd);
  const invalidHomeAfter = snapshot(invalidHome);
  const invalidCodexAfter = snapshot(invalidCodex);
  invalidRun.filesystem = {
    cwdBefore: invalidCwdBefore,
    cwdAfter: invalidCwdAfter,
    homeBefore: invalidHomeBefore,
    homeAfter: invalidHomeAfter,
    codexBefore: invalidCodexBefore,
    codexAfter: invalidCodexAfter,
  };
  assert.notEqual(invalidRun.status, 0, "file-valued ELPIS_HOME unexpectedly succeeded");
  assert.deepEqual(invalidCwdAfter, invalidCwdBefore, "invalid startup changed existing cwd files");
  assert.deepEqual(invalidHomeAfter, invalidHomeBefore, "invalid startup changed existing HOME files");
  assert.deepEqual(invalidCodexAfter, invalidCodexBefore, "invalid startup changed fixture .codex data");
}

let failure;
try {
  run();
  observations.result = "pass";
} catch (error) {
  failure = error;
  observations.result = "fail";
  observations.failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  observations.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(evidenceRoot, "observations.json"),
    JSON.stringify(observations, null, 2) + "\n",
  );
  process.stderr.write(`evidence: ${evidenceRoot}\n`);
}

if (failure) throw failure;
process.stdout.write("Elpis startup home-isolation harness passed.\n");
