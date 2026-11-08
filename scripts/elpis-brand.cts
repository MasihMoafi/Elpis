#!/usr/bin/env node
const { lexRust, scanText, editsFor, applyEdits }: typeof import('./elpis-brand-scan.cts') = require('./elpis-brand-scan.cts');
import type { Edit } from './elpis-brand-scan.cts';
const { SCOPE, EXCLUDED_PATHS, EXCEPTIONS, LITERAL_EXCEPTIONS, RULES }: typeof import('./elpis-brand-rules.cts') = require('./elpis-brand-rules.cts');
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
//   node scripts/elpis-brand.cts            apply the rename
//   node scripts/elpis-brand.cts --dry-run  list file:line old -> new, write nothing
//   node scripts/elpis-brand.cts --check    exit 1 if any rename is pending or any
//                                           exception/exclusion no longer matches
//   --root <dir>                            the codex-rs tree (default: ../codex-rs)
//
// Running it twice changes nothing the second time.
"use strict";

const fs: typeof import('node:fs') = require("node:fs");
const path: typeof import('node:path') = require("node:path");
type Change = { relPath: string; src: string; next: string; edits: Edit[] };
type RunOptions = { root: string; mode: 'apply' | 'dry-run' | 'check'; log?: (line: string) => void };

function walk(dir: string, out: string[]): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "target") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".rs") || entry.name.endsWith(".snap")) out.push(full);
  }
  return out;
}

function run({ root, mode, log = console.log }: RunOptions) {
  const usedExceptions = new Set<number>();
  const usedLiteralExceptions = new Set<number>();
  const usedExclusions = new Set<number>();
  const changes: Change[] = [];
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
      for (const line of oldLines) lineStarts.push((lineStarts[lineStarts.length - 1] as number) + line.length + 1);
      const lineOf = (offset: number) => lineStarts.findLastIndex((start) => start <= offset) + 1;
      const lines = new Set(change.edits.map((e) => lineOf(e.start)));
      for (const line of lines) {
        log(`${change.relPath}:${line}: ${(oldLines[line - 1] as string).trim()} -> ${(newLines[line - 1] as string).trim()}`);
      }
    }
  }
  if (mode === "check") for (const entry of unused) log(`unused ${entry}`);
  log(`${mode}: ${occurrences} occurrence(s) in ${changes.length} file(s)` +
    (mode === "check" ? `, ${unused.length} unused exception(s)/exclusion(s)` : ""));
  return { occurrences, files: changes.length, unused, changes };
}

function main(argv: string[]) {
  const mode = argv.includes("--check") ? "check" : argv.includes("--dry-run") ? "dry-run" : "apply";
  const rootIndex = argv.indexOf("--root");
  const root = path.resolve(rootIndex >= 0 ? argv[rootIndex + 1] as string : path.join(__dirname, "..", "codex-rs"));
  const result = run({ root, mode });
  if (mode === "check" && (result.occurrences > 0 || result.unused.length > 0)) process.exitCode = 1;
}

module.exports = { EXCEPTIONS, EXCLUDED_PATHS, LITERAL_EXCEPTIONS, RULES, SCOPE, editsFor, lexRust, run, scanText };

export type BrandApi = { EXCEPTIONS: typeof EXCEPTIONS; LITERAL_EXCEPTIONS: typeof LITERAL_EXCEPTIONS; SCOPE: typeof SCOPE; editsFor: typeof editsFor; run: typeof run };

if (require.main === module) main(process.argv.slice(2));
