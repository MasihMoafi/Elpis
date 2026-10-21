// Host/CI receipt: the same deterministic crash, unchanged bridge fails, candidate passes ten times.
// node tools/elpis-claude/test/restart-recovery-host.mjs --engine /abs/elpis-next \
//   --baseline <unchanged-commit> --evidence /abs/owned/evidence
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
const evidence = values.evidence;
fs.mkdirSync(evidence, { recursive: true });
const baseline = fs.mkdtempSync(path.join(evidence, "unchanged-"));
const archive = execFileSync("git", ["archive", "--format=tar", values.baseline, "tools/elpis-claude"], { cwd: repository, maxBuffer: 16 * 1024 * 1024 });
execFileSync("tar", ["-xf", "-", "-C", baseline], { input: archive });
fs.symlinkSync(fs.realpathSync(new URL("../node_modules", import.meta.url)), path.join(baseline, "tools/elpis-claude/node_modules"));
const engine = fs.realpathSync(values.engine);
const sha256 = file => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
fs.writeFileSync(path.join(evidence, "provenance.json"), JSON.stringify({ engine, sha256: sha256(engine),
  node: process.execPath, nodeVersion: process.version, baseline: values.baseline,
  candidate: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim(),
  candidateBridgeSha256: sha256(new URL("../acp-bridge.mjs", import.meta.url)), testSha256: sha256(test) }, null, 2) + "\n");

function run(label, bridge) {
  const env = { ...process.env, A124_ENGINE: engine, A124_BRIDGE: bridge };
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-name-pattern=a bridge restart recovers", test],
    { cwd: repository, env, encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  fs.writeFileSync(path.join(evidence, `${label}.tap`), output);
  console.log(`${label}: ${result.status === 0 ? "PASS" : "FAIL"}`);
  if (result.error) throw result.error;
  return { status: result.status, output };
}
const before = run("before", path.join(baseline, "tools/elpis-claude/acp-bridge.mjs"));
assert.notEqual(before.status, 0, "the unchanged product must fail the planted crash");
assert.match(before.output, /thread not loaded:/, "a startup/sandbox error is not the host reproduction");
for (let attempt = 1; attempt <= 10; attempt++) {
  const after = run(`after-${attempt}`, fileURLToPath(new URL("../acp-bridge.mjs", import.meta.url)));
  assert.equal(after.status, 0, `candidate run ${attempt} failed; see ${evidence}`);
  assert.match(after.output, /# pass 1\b/);
}
console.log(`A124b: unchanged failure and 10 consecutive passes; ${evidence}`);
