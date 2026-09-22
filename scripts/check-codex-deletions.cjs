// Source-only migration gate. This does not prove runtime network/privacy behavior.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
const failures = [];
function check(label, fn) {
  try { fn(); } catch (error) { failures.push(`${label}: ${error.message}`); }
}
for (const removed of [
  "analytics", "feedback", "cloud-tasks", "cloud-tasks-client",
  "realtime-webrtc", "v8-poc", "core/src/memories", "tui/src/pets",
  "memories/read", "memories/write", "ext/memories",
]) {
  check(`deleted ${removed}`, () => assert(!fs.existsSync(path.join(root, "codex-rs", removed)),
    "removed subsystem is present"));
}
check("removed upstream memory response hooks", () => {
  const source = fs.readFileSync(path.join(root, "codex-rs/core/src/stream_events_utils.rs"), "utf8");
  for (const removed of ["codex_memories_read", "memories_for_version",
    "record_stage1_output_usage", "mark_thread_memory_mode_polluted"]) {
    assert(!source.includes(removed), `${removed} remains in the live response path`);
  }
});
for (const retained of ["code-mode", "connectors", "windows-sandbox-rs"]) {
  check(`retained ${retained}`, () => assert(fs.existsSync(path.join(root, "codex-rs", retained, "Cargo.toml")),
    "required subsystem is missing"));
}
check("telemetry defaults", () => {
  const text = fs.readFileSync(path.join(root, "codex-rs/config/src/types.rs"), "utf8");
  const defaults = text.match(/impl Default for OtelConfig\s*\{([\s\S]*?)\n\}/)?.[1];
  assert(defaults, "cannot locate OtelConfig default; review gate for upstream changes");
  for (const field of ["exporter", "trace_exporter", "metrics_exporter"]) {
    assert(new RegExp(`^\\s*${field}: OtelExporterKind::None,`, "m").test(defaults),
      `${field} is not explicitly disabled`);
  }
  assert(/log_user_prompt:\s*false/.test(defaults), "prompt logging is not explicitly disabled");
});
check("default regression coverage", () => {
  const text = fs.readFileSync(path.join(root, "codex-rs/core/src/config/config_tests.rs"), "utf8");
  assert(text.includes("fn metrics_exporter_defaults_to_none_when_missing("),
    "Elpis missing-config telemetry regression test is absent");
});
console.log(JSON.stringify({
  passed: failures.length === 0,
  scope: "Source deletion/retention and telemetry-default checks only; run Rust tests and runtime privacy checks separately.",
  failures,
}, null, 2));
if (failures.length) process.exitCode = 1;
