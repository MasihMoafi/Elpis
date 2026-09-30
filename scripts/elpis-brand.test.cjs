// Eval for scripts/elpis-brand.cjs.
// usage: node scripts/elpis-brand.test.cjs            fixtures only
//        node scripts/elpis-brand.test.cjs --tree     also require the real tree to be branded
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const brand = require("./elpis-brand.cjs");

const script = path.join(__dirname, "elpis-brand.cjs");
const failures = [];
function check(label, fn) {
  try { fn(); } catch (error) { failures.push(`${label}: ${error.message}`); }
}
function transform(relPath, src) {
  const { edits } = brand.editsFor(relPath, src);
  let out = "";
  let last = 0;
  for (const edit of edits) { out += src.slice(last, edit.start) + edit.to; last = edit.end; }
  return out + src.slice(last);
}
const rustLiteral = (text) => `"${text.replace(/"/g, '\\"')}"`;

const RUST_BEFORE = String.raw`use codex_core::CodexStatus;
// Codex in a comment stays.
fn f(codex_home: &Path) {
    let quote = '"';
    let a = "Ask Codex to do anything";
    let b = r#"Run ` + "`codex resume`" + String.raw` "quoted" by Codex"#;
    let c = "queued work.\nCodex exits to update";
    let d = " before codex could run ";
    let e = "Run ` + "`codex {action}`" + String.raw` without an ID";
    let f = "Usage: codex exec [OPTIONS]";
    let i = "Fork a Codex task. A Codex home. data Codex";
    let g = vec!["codex".to_string(), "--remote".to_string()];
    let h = "codex".style(x);
    let keep = ["~/.codex/config.toml", "https://chatgpt.com/codex?x=1", "codex", "codex-tui",
        "OpenAI.Codex", "gpt-5.1-codex-mini", "dotCodexFolder", "CODEX_HOME", "codex home",
        "OpenAI\\Codex\\requirements.toml", "Codex docs"];
}
`;
const RUST_AFTER = String.raw`use codex_core::CodexStatus;
// Codex in a comment stays.
fn f(codex_home: &Path) {
    let quote = '"';
    let a = "Ask Elpis to do anything";
    let b = r#"Run ` + "`elpis resume`" + String.raw` "quoted" by Elpis"#;
    let c = "queued work.\nElpis exits to update";
    let d = " before Elpis could run ";
    let e = "Run ` + "`elpis {action}`" + String.raw` without an ID";
    let f = "Usage: elpis exec [OPTIONS]";
    let i = "Fork an Elpis task. An Elpis home. data Elpis";
    let g = vec!["elpis".to_string(), "--remote".to_string()];
    let h = "codex".style(x);
    let keep = ["~/.codex/config.toml", "https://chatgpt.com/codex?x=1", "codex", "codex-tui",
        "OpenAI.Codex", "gpt-5.1-codex-mini", "dotCodexFolder", "CODEX_HOME", "codex home",
        "OpenAI\\Codex\\requirements.toml", "Codex docs"];
}
`;

check("literals renamed; identifiers, comments, paths, URLs, IDs and exceptions kept", () => {
  assert.equal(transform("tui/src/fixture.rs", RUST_BEFORE), RUST_AFTER);
});

check("the exec reply label is renamed only in exec/src", () => {
  assert(transform("exec/src/fixture.rs", RUST_BEFORE).includes('"elpis".style(x)'), "exec label kept");
  assert(transform("tui/src/fixture.rs", RUST_BEFORE).includes('"codex".style(x)'), "label renamed outside exec");
});

check("clap doc comments become help text; other doc comments and module docs stay", () => {
  const body = "//! Codex module.\n/// Run Codex non-interactively.\nstruct Cli { exec: bool }\n";
  assert.equal(
    transform("cli/src/fixture.rs", `#[derive(Debug, Parser)]\n${body}`),
    "#[derive(Debug, Parser)]\n//! Codex module.\n/// Run Elpis non-interactively.\nstruct Cli { exec: bool }\n",
  );
  assert.equal(transform("cli/src/fixture.rs", body), body);
});

check("snapshot bodies are renamed, headers are not", () => {
  const snap = "---\nsource: tui/src/x.rs\nexpression: \"Codex\"\n---\n› Ask Codex to do anything\n  codex resume THREAD_ID\n";
  assert.equal(
    transform("tui/src/snapshots/x.snap", snap),
    "---\nsource: tui/src/x.rs\nexpression: \"Codex\"\n---\n› Ask Elpis to do anything\n  elpis resume THREAD_ID\n",
  );
});

check("every exception protects its sample, and the sample would be renamed without it", () => {
  brand.EXCEPTIONS.forEach((exception, index) => {
    const file = `tui/src/sample_${index}.rs`;
    const src = `const S: &str = ${rustLiteral(exception.sample)};\n`;
    const kept = brand.editsFor(file, src);
    assert(kept.excepted.has(index), `${exception.re} does not match its sample`);
    const bodyStart = src.indexOf('"') + 1;
    exception.re.lastIndex = 0;
    const span = exception.re.exec(src.slice(bodyStart, src.lastIndexOf('"')));
    const start = bodyStart + span.index;
    const inside = (edit) => edit.start >= start && edit.end <= start + span[0].length;
    assert(!kept.edits.some(inside), `${exception.re} sample is renamed anyway`);
    brand.EXCEPTIONS.splice(index, 1);
    try {
      assert(brand.editsFor(file, src).edits.some(inside), `${exception.re} is not needed`);
    } finally {
      brand.EXCEPTIONS.splice(index, 0, exception);
    }
  });
});

check("the script is idempotent on the fixture", () => {
  assert.equal(transform("tui/src/fixture.rs", RUST_AFTER), RUST_AFTER);
});

// A throwaway tree: a pending rename, every exception sample, and one file per exclusion.
check("--check fails before applying, apply is a no-op the second time, --check then passes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "elpis-brand-"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("tui/src/pending.rs", 'const A: &str = "Ask Codex to do anything";\n');
  write("tui/src/samples.rs",
    `const S: &[&str] = &[\n${brand.EXCEPTIONS.map((e) => `    ${rustLiteral(e.sample)},\n`).join("")}];\n`);
  for (const rel of ["tui/src/elpis_owned.rs", "cli/src/doctor.rs", "cli/src/desktop_app/mac.rs",
    "tui/src/pets/catalog.rs", "tui/src/analytics/normalize.rs"]) {
    write(rel, 'const A: &str = "Ask Codex";\n');
  }
  const cli = (...args) => spawnSync(process.execPath, [script, "--root", root, ...args], { encoding: "utf8" });
  const before = cli("--check");
  assert.equal(before.status, 1, before.stdout);
  assert.match(before.stdout, /tui\/src\/pending\.rs:1: .*Ask Codex.* -> .*Ask Elpis/);
  const dry = cli("--dry-run");
  assert.equal(dry.status, 0, dry.stdout);
  assert.match(fs.readFileSync(path.join(root, "tui/src/pending.rs"), "utf8"), /Ask Codex/, "dry-run wrote");
  assert.match(cli().stdout, /apply: 1 occurrence\(s\) in 1 file\(s\)/);
  assert.match(cli().stdout, /apply: 0 occurrence\(s\) in 0 file\(s\)/);
  const after = cli("--check");
  assert.equal(after.status, 0, after.stdout);
  assert.match(fs.readFileSync(path.join(root, "tui/src/elpis_owned.rs"), "utf8"), /Ask Codex/);
  // Negative: an exception that no longer matches anything fails --check.
  fs.rmSync(path.join(root, "tui/src/samples.rs"));
  assert.equal(cli("--check").status, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

if (process.argv.includes("--tree")) {
  check("the real tree is branded and every exception and exclusion is still needed", () => {
    const result = brand.run({ root: path.join(__dirname, "..", "codex-rs"), mode: "check", log: () => {} });
    assert.equal(result.occurrences, 0, `${result.occurrences} pending rename(s); run scripts/elpis-brand.cjs`);
    assert.deepEqual(result.unused, []);
  });
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("elpis-brand: ok");
