import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BRIDGE = fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url));
const CACHE = path.join(os.homedir(), ".cache", "elpis-tests");

function launchBridge(home, log) {
  return spawn(process.execPath, [BRIDGE], {
    env: {
      HOME: home,
      ELPIS_HOME: home,
      ELPIS_NO_AGY: "1",
      ACP_BRIDGE_NO_AGENTS: "1",
      ACP_BRIDGE_LOG: log,
      PORT: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function waitUntil(check, child, stderr, description) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (check()) return;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Bridge exited before ${description}: ${stderr()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}: ${stderr()}`);
}

async function stopBridge(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise(resolve => child.once("exit", resolve)),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("ACP bridge reports when appending its log fails", async () => {
  const home = mkdtempSync(path.join(CACHE, "bridge-log-failure-"));
  const child = launchBridge(home, "/dev/full");
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    await waitUntil(() => /could not write bridge log/i.test(stderr), child, () => stderr, "a log-write warning");
  } finally {
    await stopBridge(child);
    rmSync(home, { recursive: true, force: true });
  }
});

test("ACP bridge writes its startup log without a failure warning", async () => {
  const home = mkdtempSync(path.join(CACHE, "bridge-log-success-"));
  const log = path.join(home, "bridge.log");
  const child = launchBridge(home, log);
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  try {
    await waitUntil(() => {
      try { return readFileSync(log, "utf8").includes("LISTENING"); } catch { return false; }
    }, child, () => stderr, "the startup log entry");
    assert.doesNotMatch(stderr, /could not write bridge log/i);
  } finally {
    await stopBridge(child);
    rmSync(home, { recursive: true, force: true });
  }
});
