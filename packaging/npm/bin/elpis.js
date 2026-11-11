#!/usr/bin/env node
// `npx elpis-cli` or, after `npm install -g elpis-cli`, `elpis`: runs the Elpis terminal app.
// On its first run it downloads this version's three release files from GitHub, checks each against its published
// SHA-256, and keeps them in one folder; later runs start at once. It is the same download as scripts/install-elpis.sh.
// ELPIS_NPM_HOME moves that folder; ELPIS_NPM_RELEASE_URL and ELPIS_PLATFORM exist for the tests.
"use strict";

const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { version } = require("../package.json");

const platform = process.env.ELPIS_PLATFORM || `${os.type()}-${os.arch()}`;
if (platform !== "Linux-x64") {
  process.stderr.write(
    `Elpis publishes a binary for Linux x86_64 only (detected ${platform}).\n` +
      "Build from source with `cargo build --release -p codex-cli --bin codex`.\n",
  );
  process.exit(1);
}

const release =
  process.env.ELPIS_NPM_RELEASE_URL || `https://github.com/MasihMoafi/Elpis/releases/download/v${version}`;
const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const home = process.env.ELPIS_NPM_HOME || path.join(data, "elpis-npm", version);
// The release file, and where the terminal app expects it beside itself.
const FILES = [
  ["elpis-linux-x86_64", "elpis"],
  ["elpis-code-mode-host-linux-x86_64", "codex-code-mode-host"],
  ["elpis-bwrap-linux-x86_64", path.join("codex-resources", "bwrap")],
];

/**
 * Saves `url` to `file`. curl follows the person's proxy settings, and a cut connection carries on from where it
 * stopped, in this run or the next (11 Nov: a 100 MB file was cut at 32 MB on a slow line). Without curl, fetch.
 */
async function download(url, file) {
  const curl = spawnSync(
    "curl",
    [
      ...["--fail", "--location", "--silent", "--show-error"],
      ...["--retry", "8", "--retry-delay", "2", "--retry-all-errors", "--continue-at", "-"],
      ...["--output", file, url],
    ],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
  );
  if (!curl.error) {
    if (curl.status !== 0) throw new Error(`${url}: ${curl.stderr.trim() || `curl exit ${curl.status}`}`);
    return;
  }
  if (curl.error.code !== "ENOENT") throw curl.error;
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

function sha256(file) {
  const hash = createHash("sha256");
  const handle = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1 << 20);
    for (let read; (read = fs.readSync(handle, chunk, 0, chunk.length)) > 0; ) hash.update(chunk.subarray(0, read));
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

async function install() {
  process.stderr.write(`Elpis ${version}: first run, downloading the terminal app to ${home}\n`);
  for (const [asset, place] of FILES) {
    const target = path.join(home, place);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Downloaded beside its place and renamed once checked, so a stopped or wrong download is never run.
    const incoming = `${target}.installing`;
    await download(`${release}/${asset}`, incoming);
    await download(`${release}/${asset}.sha256`, `${incoming}.sha256`);
    const expected = fs.readFileSync(`${incoming}.sha256`, "utf8").trim().split(/\s+/)[0];
    const actual = sha256(incoming);
    fs.rmSync(`${incoming}.sha256`);
    if (actual !== expected) {
      fs.rmSync(incoming);
      throw new Error(`${asset} does not match its published SHA-256 (expected ${expected}, got ${actual})`);
    }
    fs.chmodSync(incoming, 0o755);
    fs.renameSync(incoming, target);
  }
  fs.writeFileSync(path.join(home, ".complete"), `${version}\n`);
}

(async () => {
  if (!fs.existsSync(path.join(home, ".complete"))) {
    try {
      await install();
    } catch (error) {
      process.stderr.write(`Elpis could not be installed: ${error.message}\nNothing was run. Try again, or see ${release}\n`);
      process.exit(1);
    }
  }
  const result = spawnSync(path.join(home, "elpis"), process.argv.slice(2), { stdio: "inherit" });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status === null ? 1 : result.status);
})();
