// Host acceptance, without model calls, credentials, installs or builds:
// node tools/elpis-claude/test/enter-keeps-tools-host.mjs --engine /abs/elpis-next \
//   --baseline <unchanged-commit> --evidence /abs/owned/evidence
// Both real bridges and DesktopClient run against the real native engine. Only
// inference is scripted. A wrong baseline failure must never count as evidence.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { engine: { type: "string" }, baseline: { type: "string" }, evidence: { type: "string" } } });
assert.ok(values.engine && path.isAbsolute(values.engine), "--engine must name the actual native binary");
assert.ok(values.evidence && path.isAbsolute(values.evidence), "--evidence must be an absolute directory");
assert.ok(values.baseline && !values.baseline.startsWith("-"), "--baseline must name the unchanged commit");
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const test = fileURLToPath(new URL("./turn-delivery.test.mjs", import.meta.url));
const bridge = fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url));
const evidence = values.evidence;
const engine = fs.realpathSync(values.engine);
assert.ok(!engine.endsWith(".mjs"), "the scripted engine is not host-native acceptance");
fs.mkdirSync(evidence, { recursive: true });
const baseline = fs.mkdtempSync(path.join(evidence, "unchanged-"));
const archive = execFileSync("git", ["archive", "--format=tar", values.baseline, "tools/elpis-claude"], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
execFileSync("tar", ["-xf", "-", "-C", baseline], { input: archive });
fs.symlinkSync(fs.realpathSync(new URL("../node_modules", import.meta.url)), path.join(baseline, "tools/elpis-claude/node_modules"));
const digest = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.writeFileSync(path.join(evidence, "provenance.json"), JSON.stringify({ engine, engineSha256: digest(engine), node: process.execPath, nodeVersion: process.version,
  baseline: values.baseline, candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  bridgeSha256: digest(bridge), testSha256: digest(test), agentSha256: digest(new URL("./fake-acp-agent.mjs", import.meta.url)) }, null, 2) + "\n");

function run(label, selectedBridge, pattern) {
  const home = fs.mkdtempSync("/tmp/a128h-");
  const env = { PATH: process.env.PATH, HOME: home, ELPIS_HOME: path.join(home, "elpis"), CODEX_HOME: path.join(home, "codex"),
    ELPIS_CONFIG_DIR: path.join(home, "elpis"), CODEX_AUTH_HOME: home, TMPDIR: home,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"), XDG_DATA_HOME: path.join(home, ".local/share"), XDG_STATE_HOME: path.join(home, ".local/state"),
    A124_ENGINE: engine, A124_BRIDGE: selectedBridge };
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, test],
    { cwd: repository, env, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  fs.writeFileSync(path.join(evidence, `${label}.tap`), output);
  console.log(`${label}: ${result.status === 0 ? "PASS" : "FAIL"}; ${home}`);
  if (result.error) throw result.error;
  return { status: result.status, output };
}
const before = run("before", path.join(baseline, "tools/elpis-claude/acp-bridge.mjs"), "A128: (1|4) messages during");
assert.notEqual(before.status, 0, "the unchanged bridge must fail");
assert.match(before.output, /Enter must not (reject a running tool|interrupt the task)/, "a startup/sandbox failure is not a reproduced interruption");
assert.match(before.output, /# fail 2\b/, "both one-message and several-message cases must reproduce");
for (let attempt = 1; attempt <= 10; attempt++) {
  const after = run(`after-${attempt}`, bridge, "A128:");
  assert.equal(after.status, 0, `candidate host run ${attempt} failed; see ${evidence}`);
  assert.match(after.output, /# pass 7\b/, "all Claude and real native GPT scenarios must pass");
}
console.log(`A128: unchanged bridge failed and all seven scenarios passed ten times on the native host; ${evidence}`);
