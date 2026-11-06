#!/usr/bin/env node
// Ratchet for the strict checks (6 Nov, Masih: "we want to be all TypeScript with strict checks"). Each check counts
// its findings per file and compares them with strict-baseline.json: a file may only go down, and a file the baseline
// does not list must be clean. Lower counts must be recorded (--update), so a fixed finding cannot come back.
//   node scripts/strict-baseline.mjs [types|tsx|lint|dup ...] [--update] [--files a.mjs b.tsx]
// types: tsc -p tsconfig.node.json (bridge, desktop, lib, scripts as JS with checkJs);
// tsx: tsc -p tsconfig.strict.json (renderer under the extra strict flags); lint: oxlint (.oxlintrc.json);
// dup: jscpd (.jscpd.json), counted as clones per file pair. --files limits lint to those files (pre-commit).
// --update refuses to raise a count; ELPIS_BASELINE_RAISE=1 allows it, for a reviewed exception only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const app = fileURLToPath(new URL('../', import.meta.url));
const baselineFile = path.join(app, 'strict-baseline.json');
const bin = (/** @type {string} */ name) => path.join(app, 'node_modules/.bin', name);

/** @typedef {Record<string, number>} Counts */

/**
 * Compares a check's counts with its baseline.
 * @param {Counts} baseline
 * @param {Counts} actual
 * @param {string[] | null} scope files actually checked (keys are `file:rule`), or null for all
 */
export function compare(baseline, actual, scope = null) {
  /** @type {string[]} */ const worse = [];
  /** @type {string[]} */ const better = [];
  const keys = new Set([...Object.keys(baseline), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) {
    if (scope && !scope.some(file => key.startsWith(`${file}:`))) continue;
    const was = baseline[key] ?? 0;
    const now = actual[key] ?? 0;
    if (now > was) worse.push(`${key}: ${was} -> ${now}`);
    else if (now < was) better.push(`${key}: ${was} -> ${now}`);
  }
  return { worse, better };
}

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { cwd: app, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  return `${result.stdout}${result.stderr}`;
}

/** @param {string} config */
function typeCounts(config) {
  // The bridge imports generated copies in bridge/resources; make them first so every checkout counts the same program.
  run(process.execPath, ['bridge/build-resources.mjs', '--bridge-only']);
  /** @type {Counts} */ const counts = {};
  const configPath = path.join(app, config);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, { noEmit: true }, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); },
  });
  if (!parsed) throw new Error(`Cannot read ${configPath}`);
  const host = ts.createCompilerHost(parsed.options);
  const appModules = path.join(app, 'node_modules');
  const realAppModules = fs.realpathSync(appModules);
  const allowed = (/** @type {string} */ name) => {
    const absolute = path.resolve(name);
    const parts = absolute.split(path.sep);
    const index = parts.indexOf('node_modules');
    if (index < 0) return true;
    const root = parts.slice(0, index + 1).join(path.sep);
    return root === appModules || absolute === realAppModules || absolute.startsWith(`${realAppModules}${path.sep}`);
  };
  const fileExists = host.fileExists.bind(host), directoryExists = host.directoryExists?.bind(host);
  host.fileExists = name => allowed(name) && fileExists(name);
  host.directoryExists = name => allowed(name) && (directoryExists?.(name) ?? false);
  const program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  const output = ts.formatDiagnostics(diagnostics, { getCurrentDirectory: () => app, getCanonicalFileName: name => name, getNewLine: () => '\n' });
  for (const line of output.split('\n')) {
    const match = /^(.+?)\(\d+,\d+\): error (TS\d+)/.exec(line);
    if (match) counts[`${match[1]}:${match[2]}`] = (counts[`${match[1]}:${match[2]}`] ?? 0) + 1;
  }
  return counts;
}

/** @param {string[] | null} files */
export function lintCounts(files) {
  const targets = files ?? ['bridge', 'desktop', 'lib', 'scripts', 'app', 'components', 'tests'];
  if (!targets.length) return {};
  /** @type {Counts} */ const counts = {};
  for (const line of run(bin('oxlint'), ['--type-aware', '-f', 'unix', '--no-error-on-unmatched-pattern', ...targets]).split('\n')) {
    // A rule finding ends in [Error/rule]; an unused disable directive ends in a bare [Warning].
    const match = /^(.+?):\d+:\d+: .*\[(?:(?:Error|Warning)\/(.+)|Warning)\]$/.exec(line);
    if (match) {
      const key = `${match[1]}:${match[2] ?? 'unused-disable-directive'}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function dupCounts() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-jscpd-'));
  try {
    run(bin('jscpd'), ['--config', '.jscpd.json', '--reporters', 'json', '--output', output, '--silent', 'bridge', 'desktop', 'lib', 'scripts', 'app', 'components']);
    /** @type {{ duplicates: { firstFile: { name: string }, secondFile: { name: string } }[], statistics: { total: { percentage: number } } }} */
    const report = JSON.parse(fs.readFileSync(path.join(output, 'jscpd-report.json'), 'utf8'));
    /** @type {Counts} */ const counts = {};
    for (const { firstFile, secondFile } of report.duplicates) {
      const key = [firstFile.name, secondFile.name].sort().join(' ~ ');
      counts[key] = (counts[key] ?? 0) + 1;
    }
    console.log(`strict-baseline dup: ${report.statistics.total.percentage}% duplicated lines`);
    return counts;
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
}

/** @type {Record<string, (files: string[] | null) => Counts>} */
const checks = {
  types: () => typeCounts('tsconfig.node.json'),
  tsx: () => typeCounts('tsconfig.strict.json'),
  lint: files => lintCounts(files),
  dup: () => dupCounts(),
};

/** @param {Counts} counts */
const total = counts => Object.values(counts).reduce((sum, count) => sum + count, 0);

function main() {
  const args = process.argv.slice(2);
  const update = args.includes('--update');
  const filesAt = args.indexOf('--files');
  const files = filesAt >= 0 ? args.slice(filesAt + 1) : null;
  const named = (filesAt >= 0 ? args.slice(0, filesAt) : args).filter(arg => !arg.startsWith('--'));
  const selected = named.length ? named : Object.keys(checks);
  /** @type {Record<string, Counts>} */
  const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};
  let failed = false;
  for (const name of selected) {
    const check = checks[name];
    if (!check) { console.error(`strict-baseline: unknown check ${name}`); process.exit(2); }
    const actual = check(files);
    const { worse, better } = compare(baseline[name] ?? {}, actual, files);
    const recorded = Object.fromEntries(Object.entries(baseline[name] ?? {}).filter(([key]) => !files || files.some(file => key.startsWith(`${file}:`))));
    console.log(`strict-baseline ${name}: ${total(actual)} (baseline ${total(recorded)}${files ? ` for ${files.length} file(s)` : ''})`);
    if (update) {
      if (worse.length && process.env.ELPIS_BASELINE_RAISE !== '1') {
        console.error(`strict-baseline ${name}: --update would raise counts; fix these instead:\n  ${worse.join('\n  ')}`);
        failed = true;
        continue;
      }
      baseline[name] = Object.fromEntries(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b)));
      continue;
    }
    if (worse.length) {
      console.error(`strict-baseline ${name}: new findings (fix them; the baseline only goes down):\n  ${worse.join('\n  ')}`);
      failed = true;
    }
    if (better.length && !files) {
      console.error(`strict-baseline ${name}: fewer findings than recorded; lock them in with\n  node scripts/strict-baseline.mjs ${name} --update\n  ${better.join('\n  ')}`);
      failed = true;
    }
  }
  if (update && !failed) fs.writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 1)}\n`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
