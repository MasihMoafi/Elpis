#!/usr/bin/env node
// elpis-brand: rename the product word "Codex" to "Elpis" in user-facing text.
//
// Upstream Codex is re-vendored on every bump, so the rename is a script, not a hand
// edit. It rewrites only (a) Rust string literals, (b) `///` doc comments in files that
// derive clap commands (those become --help text), and (c) the body of insta `.snap`
// files, so upstream tests that asserted the old wording stay consistent. Identifiers,
// module and crate names, comments, paths (`~/.codex`, `codex_home`), env vars
// (`CODEX_*`), URLs and JSON field names are never touched: the rules only fire on the
// standalone word, never after `.`, `/`, `\`, `-`, `_`, `~` or a letter.
//
// Every replacement is five characters for five, so wrapped snapshots keep their layout;
// the one exception is the article, "a Codex" -> "an Elpis".
// Text where "Codex" truly means OpenAI's product, or that another crate parses, is kept
// and listed in EXCEPTIONS with the reason. A string that is only ever an identifier by
// where it sits (a path component, an originator prefix) is kept by LITERAL_EXCEPTIONS.
//
//   node scripts/elpis-brand.cjs            apply the rename
//   node scripts/elpis-brand.cjs --dry-run  list file:line old -> new, write nothing
//   node scripts/elpis-brand.cjs --check    exit 1 if any rename is pending or any
//                                           exception/exclusion no longer matches
//   --root <dir>                            the codex-rs tree (default: ../codex-rs)
//
// Running it twice changes nothing the second time.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Directories rewritten, relative to codex-rs/. `files`, when present, narrows a directory
// to the paths that match it.
const SCOPE = [
  { dir: "tui/src", why: "the TUI" },
  { dir: "cli/src", why: "CLI help and messages" },
  { dir: "exec/src", why: "`elpis exec` output and help" },
  { dir: "tui/tests", why: "integration tests that assert the TUI wording" },
  { dir: "cli/tests", why: "integration tests that assert the CLI wording" },
  { dir: "exec/tests", why: "integration tests that assert the exec wording" },
  { dir: "features/src", why: "descriptions the /experimental menu shows" },
  { dir: "config/src", why: "config warnings and errors the user reads" },
  { dir: "app-server/src", why: "messages the app server sends its clients; the TUI shows them" },
  { dir: "login/src", why: "the device-code banner, sign-in errors and the browser callback messages" },
  { dir: "model-provider/src", why: "provider and credential errors the user reads" },
  { dir: "login/tests", why: "integration tests that assert the login wording" },
  {
    dir: "app-server/tests",
    files: /^app-server\/tests\/suite\/v2\/(?:bedrock_setup|feedback|gateway_oauth_tests|model_list_requirements_tests|model_provider_enforcement_tests)\.rs$/,
    why: "only the tests that assert app-server wording; the rest assert core's prompts and other crates' output, which stay Codex",
  },
];

// Files left alone entirely. Paths are relative to codex-rs/.
const EXCLUDED_PATHS = [
  {
    re: /(^|\/)[^/]*elpis[^/]*$|^tui\/src\/branding\.rs$/,
    why: "Elpis-owned code; its evals assert that Codex wording is absent",
  },
  {
    re: /^cli\/src\/doctor(\.rs$|\/)|^cli\/src\/snapshots\/codex__doctor__|^cli\/tests\/(snapshots\/)?doctor_/,
    why: "`doctor` diagnoses OpenAI's Codex install and desktop app (package IDs, signing identities, endpoint-security exclusions); hidden from help",
  },
  {
    re: /^cli\/src\/desktop_app\//,
    why: "installs and launches OpenAI's Codex desktop app (Codex.app, OpenAI.Codex)",
  },
  {
    re: /^tui\/src\/pets\/|\/snapshots\/[^/]*pets[^/]*\.snap$/,
    why: "/pets is hidden in Elpis; 'Codex' there is OpenAI's pet character",
  },
  {
    re: /^tui\/src\/analytics\//,
    why: "labels OpenAI's usage-analytics surfaces (Codex, JetBrains, GitHub) returned by the ChatGPT backend",
  },
];

// Text kept as "Codex". `sample` is a real string each entry protects; the eval checks
// it survives and that it would be renamed without the entry.
const EXCEPTIONS = [
  {
    re: /OpenAI(?:'s)? Codex|Codex, OpenAI's/g,
    why: "names OpenAI's product outright; Elpis evals assert this upstream title is gone",
    sample: ">_ OpenAI Codex (v0.0.0)",
  },
  {
    re: /Codex docs/g,
    why: "link text for developers.openai.com/codex, OpenAI's documentation",
    sample: "Codex docs",
  },
  {
    re: /Codex keymap documentation/g,
    why: "OpenAI's keymap documentation; Elpis has none",
    sample: "See the Codex keymap documentation for supported actions and examples.",
  },
  {
    re: /Codex Cloud/g,
    why: "OpenAI's hosted Codex Cloud (the `cloud` subcommand)",
    sample: "[EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally.",
  },
  {
    re: /Codex-optimized|Optimized for Codex/g,
    why: "OpenAI model-catalog descriptions of OpenAI's models",
    sample: "Optimized for Codex. Cheaper, faster, but less capable.",
  },
  {
    re: /Codex is currently experiencing high load/g,
    why: "status of OpenAI's backend, not of Elpis",
    sample: "Codex is currently experiencing high load.",
  },
  {
    re: /enable Codex plugins/g,
    why: "a ChatGPT workspace admin setting named by OpenAI",
    sample: "Ask a workspace admin to enable Codex plugins or plugin sharing",
  },
  {
    re: /Codex is included in your plan/g,
    why: "OpenAI plan promotion; false if said of Elpis",
    sample: "*New* For a limited time, Codex is included in your plan for free",
  },
  {
    re: /Update Codex to the latest version|Updating Codex via|Update ran successfully! Please restart Codex|`codex update` is not available|release build of Codex|detect the Codex installation method/g,
    why: "`update` runs OpenAI's Codex installer (npm @openai/codex, brew codex, chatgpt.com/codex/install.sh); it does not update Elpis",
    sample: "`codex update` is not available in debug builds. Install a release build of Codex to use this command.",
  },
  {
    re: /## My request for Codex:/g,
    why: "model-visible marker that codex-rs/protocol (USER_MESSAGE_BEGIN) parses; renaming one side breaks title and summary extraction",
    sample: "\\n## My request for Codex:\\n",
  },
  {
    re: /Read the Codex goal objective file at/g,
    why: "persisted goal-objective prefix that goal_files.rs parses back; renaming it orphans goals saved before",
    sample: "Read the Codex goal objective file at ",
  },
  {
    re: /is archived\. Run `codex unarchive/g,
    why: "the error codex-rs/app-server returns (two sites); session_start.rs in the TUI recognises it by this text",
    sample: " is archived. Run `codex unarchive ",
  },
  {
    re: /or run `codex app-server daemon start`/g,
    why: "text codex-rs/app-server-daemon prints, asserted by a TUI snapshot",
    sample: "repair the existing installation, or run `codex app-server daemon start` to install",
  },
  {
    re: /^codex [^\n:`]*:/gm,
    why: "a test's argv (`codex ...`) echoed at the start of a snapshot line; test argv stays `codex`",
    sample: "codex exec review --worktree: `--worktree` is not supported for code review",
  },
  {
    re: /Co-authored-by: Codex/g,
    why: "commit trailer codex-rs/core adds; the CLI test asserts core's output",
    sample: "Co-authored-by: Codex <noreply@openai.com>",
  },
  {
    re: /Please run 'codex login'/g,
    why: "text codex-rs/cloud-tasks prints; the CLI test asserts it",
    sample: "Not signed in. Please run 'codex login'",
  },
  {
    re: /Codex Desktop/g,
    why: "client name the app server, core and otel match on (`name == \"Codex Desktop\"`, originator mapping); the desktop app is OpenAI's",
    sample: "(ConnectionOrigin::Stdio, \"Codex Desktop\", true, true, true)",
  },
  {
    re: /Codex-App_2/g,
    why: "a tool-namespace identifier fixture for validate_dynamic_tools, not prose",
    sample: "Some(\"Codex-App_2\")",
  },
  {
    re: /Codex Auth/g,
    why: "the OS keyring service name; renaming it orphans every saved login",
    sample: "const KEYRING_SERVICE: &str = \"Codex Auth\";",
  },
  {
    re: /Codex Companion/g,
    why: "the name of a third-party plugin in a hooks fixture, not this program",
    sample: "Optional stop-time review gate for Codex Companion.",
  },
  {
    re: /You do not have access to Codex|Codex is not enabled for your workspace|(?:request|get) access to Codex|authorized to use Codex|Codex access denial/g,
    why: "says the ChatGPT account lacks OpenAI's Codex entitlement (missing_codex_entitlement); it is not about this program",
    sample: "Codex is not enabled for your workspace. Contact your workspace administrator to request access to Codex.",
  },
  {
    re: /this Codex server/g,
    why: "the OpenAI auth server the login talks to; Elpis has no server of its own",
    sample: "device code login is not enabled for this Codex server. Use the browser login.",
  },
  {
    re: /invalid Codex open app URL/g,
    why: "names CODEX_OPEN_APP_URL, the link that opens OpenAI's Codex desktop app",
    sample: "invalid Codex open app URL: relative URL without a base",
  },
  {
    re: /Sanitized Codex user agent|base Codex user agent|default Codex originator/g,
    why: "logs about the user-agent and originator header values, which stay Codex-prefixed for OpenAI's backend",
    sample: "Falling back to default Codex originator because base user agent string is invalid",
  },
  {
    re: /update or unset it, then restart Codex/g,
    why: "core/src/client_tests.rs asserts this Bedrock message verbatim and core is out of scope; rename both together",
    sample: "update or unset it, then restart Codex",
  },
];

// A string literal kept as "Codex" because of the code around it, not its wording. `before`
// is tested against the source just ahead of the literal, `body` against its contents.
// `sample` is Rust source the entry protects; the eval checks it survives and would be
// renamed without the entry.
const LITERAL_EXCEPTIONS = [
  {
    before: /(?:\.join|Path::new)\("OpenAI"\)\s*\.join\(\s*$/,
    body: /^Codex$/,
    why: "the Windows ProgramData directory OpenAI\\Codex where managed config and requirements are read",
    sample: 'program_data.join("OpenAI").join("Codex")',
  },
  {
    before: /(?:\.starts_with|is_first_party_originator)\(\s*$/,
    body: /^Codex /,
    why: "the first-party originator prefix (`Codex Desktop`, ...) that login matches and OpenAI's backend sees",
    sample: 'originator_value.starts_with("Codex ")',
  },
];

// The multitool's subcommands; `codex <one of these>` is a command the user types.
const SUBCOMMANDS = [
  "agents", "app", "app-server", "apply", "archive", "cloud", "completion", "debug",
  "delete", "doctor", "exec", "exec-server", "features", "fork", "login", "logout", "mcp",
  "migrate-rollouts", "plugin", "queue", "remote-control", "resume", "review", "sandbox",
  "unarchive", "update",
];

// A word is standalone unless a letter, digit or one of `_ . / \ ~ -` touches it.
const NOT_AFTER = String.raw`(?<![\w./\\~-])`;
const RULES = [
  { name: "product", re: new RegExp(`${NOT_AFTER}Codex(?!\\w)`, "g"), to: "Elpis" },
  // "You approved codex to run", "before codex could apply": the agent as actor.
  {
    name: "actor",
    re: new RegExp(`${NOT_AFTER}codex(?= (?:to|could|network access)\\b)`, "g"),
    to: "Elpis",
  },
  // "run codex resume", "Usage: codex exec", "codex --no-daemon", "`codex`", "`codex {cmd}`".
  {
    name: "command",
    re: new RegExp(
      `${NOT_AFTER}codex(?= (?:${SUBCOMMANDS.join("|")})(?![\\w-])| --?[a-z])|(?<=\`)codex(?=[\` ])` +
        // The same command right after a color escape in a Rust literal: "\u{1b}[36mcodex resume".
        `|(?<=\\u\\{1b\\}\\[[0-9;]*m)codex(?= (?:${SUBCOMMANDS.join("|")})(?![\\w-]))`,
      "g",
    ),
    to: "elpis",
  },
];

// A bare "codex" literal is a binary or ID and stays, except as the head of a command
// vector the user is told to run: `vec!["codex".to_string(), ...]` (the reconnect hint).
const COMMAND_HEAD = /vec!\[\s*$/;

const CLAP_DERIVE = /derive\([^)]*\b(?:clap::)?(?:Parser|Args|Subcommand|ValueEnum)\b/;

// Minimal Rust lexer: string literals (plain, raw, byte) and comments, with offsets.
function lexRust(src) {
  const tokens = [];
  const n = src.length;
  const isIdent = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      let end = src.indexOf("\n", i);
      if (end < 0) end = n;
      const text = src.slice(i, end);
      const doc = text.startsWith("///") && !text.startsWith("////");
      tokens.push({ kind: doc ? "doc" : "comment", start: i, end, bodyStart: i + (doc ? 3 : 2), bodyEnd: end });
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") { depth++; j += 2; }
        else if (src[j] === "*" && src[j + 1] === "/") { depth--; j += 2; }
        else j++;
      }
      i = j;
      continue;
    }
    if (!isIdent(src[i - 1])) {
      const raw = /^(?:b|c|br|cr)?r(#*)"/.exec(src.slice(i, i + 64));
      if (raw) {
        const close = `"${raw[1]}`;
        const bodyStart = i + raw[0].length;
        const bodyEnd = src.indexOf(close, bodyStart);
        if (bodyEnd < 0) throw new Error(`unterminated raw string at offset ${i}`);
        tokens.push({ kind: "str", raw: true, start: i, end: bodyEnd + close.length, bodyStart, bodyEnd });
        i = bodyEnd + close.length;
        continue;
      }
      const plain = /^(?:b|c)?"/.exec(src.slice(i, i + 2));
      if (plain) {
        const bodyStart = i + plain[0].length;
        let j = bodyStart;
        while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
        if (j >= n) throw new Error(`unterminated string at offset ${i}`);
        tokens.push({ kind: "str", raw: false, start: i, end: j + 1, bodyStart, bodyEnd: j });
        i = j + 1;
        continue;
      }
    }
    if (c === "'") {
      // Char literal ('x', '\n', '\u{1b}', '"') or a lifetime ('a).
      if (src[i + 1] === "\\") {
        let j = i + 3;
        while (j < n && src[j] !== "'") j++;
        i = j + 1;
        continue;
      }
      const width = src.codePointAt(i + 1) > 0xffff ? 2 : 1;
      i += src[i + 1 + width] === "'" ? 2 + width : 1;
      continue;
    }
    if (isIdent(c)) {
      // String prefixes (`b"`, `r#"`) were matched above, so this is a plain identifier.
      while (i < n && isIdent(src[i])) i++;
      continue;
    }
    i++;
  }
  return tokens;
}

// A same-length view of an escaped literal body: `\n`, `\t`, `\r` read as the whitespace
// they print, so "…\nCodex" is a standalone word. Offsets are unchanged.
function unescapedView(body) {
  return body.replace(/\\[\\"'nrt0]/g, (escape) => (escape === "\\\\" ? escape : ` ${escape[1] === "n" || escape[1] === "r" || escape[1] === "t" ? " " : escape[1]}`));
}

// Occurrences in `text` the rules would rename, split into renamed and excepted.
function scanText(text) {
  const spans = [];
  EXCEPTIONS.forEach((exception, index) => {
    exception.re.lastIndex = 0;
    for (const m of text.matchAll(exception.re)) {
      spans.push({ index, start: m.index, end: m.index + m[0].length });
    }
  });
  const renames = [];
  const excepted = new Set();
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const start = m.index;
      const end = start + m[0].length;
      const cover = spans.find((span) => span.start <= start && end <= span.end);
      if (cover) excepted.add(cover.index);
      else {
        renames.push({ start, end, to: rule.to, rule: rule.name });
        // "a Codex task" reads "an Elpis task".
        if (rule.to === "Elpis" && /(?:^|[^\w])[Aa] $/.test(text.slice(Math.max(0, start - 3), start))) {
          renames.push({ start: start - 1, end: start - 1, to: "n", rule: "article" });
        }
      }
    }
  }
  return { renames, excepted };
}

// Edits (absolute offsets) for one file, plus the exceptions it exercised.
function editsFor(relPath, src) {
  const edits = [];
  const excepted = new Set();
  const literalExcepted = new Set();
  const collect = (text, offset) => {
    const result = scanText(text);
    for (const r of result.renames) edits.push({ start: offset + r.start, end: offset + r.end, to: r.to });
    for (const index of result.excepted) excepted.add(index);
  };
  if (relPath.endsWith(".snap")) {
    const header = /^---\n[\s\S]*?\n---\n/.exec(src);
    const offset = header ? header[0].length : 0;
    collect(src.slice(offset), offset);
  } else {
    const clapFile = CLAP_DERIVE.test(src);
    for (const token of lexRust(src)) {
      if (token.kind === "str") {
        const body = src.slice(token.bodyStart, token.bodyEnd);
        const before = src.slice(Math.max(0, token.start - 96), token.start);
        const literalIndex = LITERAL_EXCEPTIONS.findIndex((e) => e.body.test(body) && e.before.test(before));
        if (literalIndex >= 0) {
          if (scanText(body).renames.length) literalExcepted.add(literalIndex);
          continue;
        }
        const replyLabel = relPath.startsWith("exec/src/") && src.startsWith(".style(", token.end);
        const commandHead = COMMAND_HEAD.test(src.slice(Math.max(0, token.start - 64), token.start)) &&
          src.startsWith(".to_string()", token.end);
        // The `elpis exec` reply label, `"codex".style(...)`, and the reconnect command head.
        if (body === "codex" && (replyLabel || commandHead)) {
          edits.push({ start: token.bodyStart, end: token.bodyEnd, to: "elpis" });
          continue;
        }
        collect(token.raw ? body : unescapedView(body), token.bodyStart);
      } else if (token.kind === "doc" && clapFile) {
        collect(src.slice(token.bodyStart, token.bodyEnd), token.bodyStart);
      }
    }
  }
  edits.sort((a, b) => a.start - b.start);
  return { edits, excepted, literalExcepted };
}

function applyEdits(src, edits) {
  let out = "";
  let last = 0;
  for (const edit of edits) {
    out += src.slice(last, edit.start) + edit.to;
    last = edit.end;
  }
  return out + src.slice(last);
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "target") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".rs") || entry.name.endsWith(".snap")) out.push(full);
  }
  return out;
}

function run({ root, mode, log = console.log }) {
  const usedExceptions = new Set();
  const usedLiteralExceptions = new Set();
  const usedExclusions = new Set();
  const changes = [];
  let occurrences = 0;
  for (const scope of SCOPE) {
    for (const file of walk(path.join(root, scope.dir), []).sort()) {
      const relPath = path.relative(root, file).split(path.sep).join("/");
      if (scope.files && !scope.files.test(relPath)) continue;
      const src = fs.readFileSync(file, "utf8");
      const exclusion = EXCLUDED_PATHS.findIndex((entry) => entry.re.test(relPath));
      if (exclusion >= 0) {
        if (editsFor(relPath, src).edits.length) usedExclusions.add(exclusion);
        continue;
      }
      const { edits, excepted, literalExcepted } = editsFor(relPath, src);
      for (const index of excepted) usedExceptions.add(index);
      for (const index of literalExcepted) usedLiteralExceptions.add(index);
      if (!edits.length) continue;
      const next = applyEdits(src, edits);
      occurrences += edits.length;
      changes.push({ relPath, src, next, edits });
      if (mode === "apply") fs.writeFileSync(file, next);
    }
  }
  const unused = [
    ...EXCEPTIONS.filter((_, index) => !usedExceptions.has(index)).map((e) => `exception ${e.re}`),
    ...LITERAL_EXCEPTIONS.filter((_, index) => !usedLiteralExceptions.has(index)).map((e) => `literal exception ${e.before} ${e.body}`),
    ...EXCLUDED_PATHS.filter((_, index) => !usedExclusions.has(index)).map((e) => `exclusion ${e.re}`),
  ];
  if (mode !== "apply") {
    for (const change of changes) {
      const oldLines = change.src.split("\n");
      const newLines = change.next.split("\n");
      const lineStarts = [0];
      for (const line of oldLines) lineStarts.push(lineStarts[lineStarts.length - 1] + line.length + 1);
      const lineOf = (offset) => lineStarts.findLastIndex((start) => start <= offset) + 1;
      const lines = new Set(change.edits.map((e) => lineOf(e.start)));
      for (const line of lines) {
        log(`${change.relPath}:${line}: ${oldLines[line - 1].trim()} -> ${newLines[line - 1].trim()}`);
      }
    }
  }
  if (mode === "check") for (const entry of unused) log(`unused ${entry}`);
  log(`${mode}: ${occurrences} occurrence(s) in ${changes.length} file(s)` +
    (mode === "check" ? `, ${unused.length} unused exception(s)/exclusion(s)` : ""));
  return { occurrences, files: changes.length, unused, changes };
}

function main(argv) {
  const mode = argv.includes("--check") ? "check" : argv.includes("--dry-run") ? "dry-run" : "apply";
  const rootIndex = argv.indexOf("--root");
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] : path.join(__dirname, "..", "codex-rs"));
  const result = run({ root, mode });
  if (mode === "check" && (result.occurrences > 0 || result.unused.length > 0)) process.exitCode = 1;
}

module.exports = { EXCEPTIONS, EXCLUDED_PATHS, LITERAL_EXCEPTIONS, RULES, SCOPE, editsFor, lexRust, run, scanText };

if (require.main === module) main(process.argv.slice(2));
