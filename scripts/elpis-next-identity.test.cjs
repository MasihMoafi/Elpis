// Identity and home-guard eval for the elpis-next binary.
// usage: node scripts/elpis-next-identity.test.cjs /absolute/path/to/binary
// Runs the binary only with fake HOMEs under a fresh temporary directory.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const EXPECTED_VERSION = process.env.ELPIS_EXPECTED_VERSION
  || fs.readFileSync(path.join(__dirname, "../codex-rs/cli/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];
const HOME_DIR = process.env.ELPIS_EXPECTED_HOME_DIR || ".elpis-next";

const binary = process.argv[2];
assert(binary && path.isAbsolute(binary), "usage: node scripts/elpis-next-identity.test.cjs /absolute/path/to/binary");
assert(fs.statSync(binary).isFile(), `binary is not a file: ${binary}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-next-identity-"));
const mkdir = (dir) => (fs.mkdirSync(dir, { recursive: true }), dir);
const sha = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function run(args, env) {
  const result = spawnSync(binary, args, {
    env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C.UTF-8", TMPDIR: root, RUST_LOG: "error", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert(!result.error, `${args.join(" ")} failed to start: ${result.error?.message}`);
  return result;
}

// A state DB whose migration 41 has the given description. v0.3.0's migration 41
// is "work graphs"; the vendored upstream's is "threads name".
function stateDb(home, migration41) {
  const file = path.join(mkdir(home), "state_5.sqlite");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE _sqlx_migrations (
    version BIGINT PRIMARY KEY, description TEXT NOT NULL,
    installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)`);
  db.prepare("INSERT INTO _sqlx_migrations (version, description, success, checksum, execution_time) VALUES (?, ?, 1, x'00', 0)")
    .run(41, migration41);
  db.close();
  return file;
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`ok   ${name}`);
  } catch (error) {
    results.push(`FAIL ${name}: ${error.message.split("\n")[0]}`);
  }
}

check("--version prints the Elpis name and version", () => {
  const home = mkdir(path.join(root, "version-home"));
  const r = run(["--version"], { HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), `elpis ${EXPECTED_VERSION}`);
});

check("--help shows elpis usage", () => {
  const home = mkdir(path.join(root, "help-home"));
  const r = run(["--help"], { HOME: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Usage: elpis \[OPTIONS\] \[PROMPT\]/);
});

check("an inherited CODEX_HOME is ignored", () => {
  const home = mkdir(path.join(root, "inherit-home"));
  const codexHome = mkdir(path.join(root, "inherited-codex-home"));
  fs.writeFileSync(path.join(codexHome, "sentinel"), "leave me alone\n");
  const r = run(["--version"], { HOME: home, CODEX_HOME: codexHome });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(codexHome), ["sentinel"], "the inherited CODEX_HOME was written to");
  assert(fs.statSync(path.join(home, HOME_DIR)).isDirectory(), `HOME/${HOME_DIR} was not used`);
});

check("refuses a home that holds a v0.3.0 state DB", () => {
  const home = path.join(root, "v030-home");
  const db = stateDb(home, "work graphs");
  const before = sha(db);
  const r = run(["--version"], { HOME: mkdir(path.join(root, "v030-fake-home")), ELPIS_HOME: home });
  assert.notEqual(r.status, 0, `started anyway: ${r.stdout}`);
  assert.match(r.stderr, /v0\.3\.0/);
  assert.equal(sha(db), before, "the v0.3.0 state DB changed");
});

check("accepts a home whose state DB is not from v0.3.0", () => {
  const home = path.join(root, "next-home");
  stateDb(home, "threads name");
  const r = run(["--version"], { HOME: mkdir(path.join(root, "next-fake-home")), ELPIS_HOME: home });
  assert.equal(r.status, 0, r.stderr);
});

process.stdout.write(`${results.join("\n")}\nevidence: ${root}\n`);
if (results.some((line) => line.startsWith("FAIL"))) process.exit(1);
