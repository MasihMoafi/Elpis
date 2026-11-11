// The npm launcher: a first run downloads the three release files, checks each against its published SHA-256 and
// runs the terminal app with the arguments given; a file that fails its checksum is never run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const launcher = join(dirname(fileURLToPath(import.meta.url)), "../bin/elpis.js");
const APP = '#!/bin/sh\necho "elpis ran: $*"\nexit 7\n';
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** A stand-in for the GitHub release: the three files and their checksum files. `broken` names one bad checksum. */
async function release(broken) {
  const files = {
    "elpis-linux-x86_64": APP,
    "elpis-code-mode-host-linux-x86_64": "host",
    "elpis-bwrap-linux-x86_64": "bwrap",
  };
  const requests = [];
  const server = createServer((request, response) => {
    const name = request.url.slice(1);
    requests.push(name);
    const asset = name.replace(/\.sha256$/, "");
    if (!(asset in files)) return response.writeHead(404).end();
    if (name.endsWith(".sha256")) return response.end(`${asset === broken ? "0".repeat(64) : sha(files[asset])}  ${asset}\n`);
    response.end(files[asset]);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

function run(env, args = []) {
  return new Promise(resolve => {
    // The stand-in release is on this machine: no proxy stands between.
    const local = { NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" };
    const child = spawn(process.execPath, [launcher, ...args], { env: { ...process.env, ...local, ...env } });
    let out = "", err = "";
    child.stdout.on("data", chunk => (out += chunk));
    child.stderr.on("data", chunk => (err += chunk));
    child.on("close", status => resolve({ status, out, err }));
  });
}

test("a first run downloads and checks the three files, then runs the app with the arguments; a second run downloads nothing", async t => {
  const home = mkdtempSync(join(tmpdir(), "elpis-npm-"));
  const source = await release();
  t.after(() => { source.close(); rmSync(home, { recursive: true, force: true }); });
  const env = { ELPIS_NPM_HOME: home, ELPIS_NPM_RELEASE_URL: source.url, ELPIS_PLATFORM: "Linux-x64" };
  const first = await run(env, ["--version", "two words"]);
  assert.equal(first.out, "elpis ran: --version two words\n");
  assert.equal(first.status, 7, "the app's own exit status comes back");
  assert.equal(source.requests.length, 6);
  assert.ok(existsSync(join(home, "codex-code-mode-host")) && existsSync(join(home, "codex-resources/bwrap")));
  assert.equal(readFileSync(join(home, "elpis"), "utf8"), APP);
  const second = await run(env, ["again"]);
  assert.equal(second.out, "elpis ran: again\n");
  assert.equal(source.requests.length, 6, "nothing is downloaded twice");
});

test("a file that does not match its published checksum is refused, and nothing is run", async t => {
  const home = mkdtempSync(join(tmpdir(), "elpis-npm-"));
  const source = await release("elpis-code-mode-host-linux-x86_64");
  t.after(() => { source.close(); rmSync(home, { recursive: true, force: true }); });
  const result = await run({ ELPIS_NPM_HOME: home, ELPIS_NPM_RELEASE_URL: source.url, ELPIS_PLATFORM: "Linux-x64" });
  assert.equal(result.status, 1);
  assert.equal(result.out, "", "the app did not run");
  assert.match(result.err, /does not match its published SHA-256/);
  assert.equal(existsSync(join(home, ".complete")), false, "the next run tries again");
});

test("another platform is told what Elpis publishes and how to build it", async () => {
  const result = await run({ ELPIS_PLATFORM: "Darwin-arm64" });
  assert.equal(result.status, 1);
  assert.match(result.err, /Linux x86_64 only \(detected Darwin-arm64\)/);
});
