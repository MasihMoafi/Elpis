import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import { heldByAncestor, missingPlaywright, passRecord, records } from './gate-guards.mts';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const tiers = ['fast', 'bridge', 'desktop', 'ui', 'opt-in'];
const ignored = new Set(['node_modules', '.next', 'out', '.tmp', '.git']);
function inspectTests(source: string, filename: string): { runner: boolean; registered: boolean } {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const names = new Set<string>(), namespaces = new Set<string>();
  let runner = false;
  const nodeTest = (node: ts.Node | undefined) => !!node && ts.isStringLiteral(node) && node.text === 'node:test';
  for (const statement of tree.statements) {
    if (ts.isImportDeclaration(statement) && nodeTest(statement.moduleSpecifier) && !statement.importClause?.isTypeOnly) {
      runner = true;
      const clause = statement.importClause;
      if (clause?.name) names.add(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
        if (!binding.isTypeOnly && ['test', 'it'].includes(binding.propertyName?.text ?? binding.name.text)) names.add(binding.name.text);
      }
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer;
      if (!call || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'require' || !nodeTest(call.arguments[0])) continue;
      runner = true;
      if (ts.isIdentifier(declaration.name)) { names.add(declaration.name.text); namespaces.add(declaration.name.text); }
      if (ts.isObjectBindingPattern(declaration.name)) for (const binding of declaration.name.elements) {
        if (ts.isIdentifier(binding.name) && ['test', 'it'].includes(binding.propertyName?.getText(tree) ?? binding.name.text)) names.add(binding.name.text);
      }
    }
  }
  let registered = false;
  const registration = (target: ts.Expression): boolean => {
    if (ts.isIdentifier(target)) return names.has(target.text);
    if (!ts.isPropertyAccessExpression(target)) return false;
    if (['skip', 'todo', 'only'].includes(target.name.text)) return registration(target.expression);
    return ts.isIdentifier(target.expression) && namespaces.has(target.expression.text) && ['test', 'it'].includes(target.name.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (registration(node.expression)) registered = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { runner, registered };
}
export async function discoverTests(directory = root, relative = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory() && !ignored.has(entry.name)) found.push(...await discoverTests(directory, file));
    else if (entry.isFile()) {
      const namedTest = /\.(?:test|spec|runtime)\.[cm]?[jt]sx?$/.test(entry.name) || file === 'tests/runtime.mts';
      if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      const source = await fs.readFile(path.join(directory, file), 'utf8');
      const { runner, registered } = inspectTests(source, file);
      if (runner ? registered : namedTest) found.push(file);
    }
  }
  return found.sort();
}

export function checkInventory(inventory: Record<string, string[]>, files: string[]) {
  const owners = new Map<string, string>(), errors: string[] = [];
  for (const tier of Object.keys(inventory)) if (!tiers.includes(tier)) errors.push(`Unknown tier: ${tier}`);
  for (const tier of tiers) {
    if (!Array.isArray(inventory[tier])) { errors.push(`Missing tier: ${tier}`); continue; }
    for (const file of inventory[tier] ?? []) {
      if (owners.has(file)) errors.push(`Duplicate test: ${file} (${owners.get(file)}, ${tier})`);
      owners.set(file, tier);
      if (!files.includes(file)) errors.push(`Missing test file: ${file}`);
    }
  }
  for (const file of files) if (!owners.has(file)) errors.push(`Unassigned test: ${file}`);
  if (errors.length) throw new Error(errors.join('\n'));
}

// `dir`, `locks` and `seconds` let the gate's own tests run it on a fake app with short limits.
export async function main(args: string[], { dir = root, locks = { build: '/tmp/elpis-desktop-build.lock', ui: '/tmp/elpis-desktop-ui.lock' }, seconds: fileSeconds = 180 } = {}) {
  const inventory: Record<string, string[]> = JSON.parse(await fs.readFile(path.join(dir, 'test-inventory.json'), 'utf8'));
  checkInventory(inventory, await discoverTests(dir));
  if (args[0] === '--check') {
    console.log(tiers.map(tier => `${tier}: ${inventory[tier]?.length}`).join(', '));
    return;
  }
  const selected = args.length ? args : tiers.filter(tier => tier !== 'opt-in');
  if (selected.some(tier => !tiers.includes(tier) || tier === 'opt-in')) throw new Error('Choose fast, bridge, desktop or ui. Run individual opt-in tests explicitly (see TESTING.md).');
  if (selected.includes('ui')) {
    const holder = heldByAncestor(locks.ui);
    if (holder) throw new Error(`Run the gate without an outer flock: it takes ${locks.ui} itself for each browser file, and process ${holder} above it already holds that lock.`);
    const missing = missingPlaywright();
    if (missing) throw new Error(missing);
  }
  const git = (args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  const start = { commit: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain', '--untracked-files=no']) === '' };
  const evidence = await fs.mkdtemp(path.join(os.tmpdir(), 'elpis-test-gate-'));
  const home = path.join(evidence, 'home');
  await fs.mkdir(home);
  const summary: { wallMs: number; testMs: number; files: { name: string; tier: string; code: number | null; testMs: number; wallMs: number; log: string }[]; evidence: string } = { wallMs: 0, testMs: 0, files: [], evidence }, started = performance.now();
  console.log(`Test evidence: ${evidence}`);
  // Files run detached, so Ctrl+C reaches only the gate: it stops the running file's group before it exits.
  let running: number | undefined;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { if (running) try { process.kill(-running, 'SIGKILL'); } catch {} process.exit(130); });
  async function run(name: string, command: string, parameters: string[], tier: string, { seconds = fileSeconds, lock }: { seconds?: number; lock?: string } = {}) {
    const log = path.join(evidence, name.replaceAll('/', '-') + '.tap'), output = await fs.open(log, 'w');
    const at = performance.now();
    let code;
    console.log(`RUN ${name} (${tier}; limit ${seconds}s)`);
    try {
      code = await new Promise<number | null>((resolve, reject) => {
        // Wait for the shared lock outside the limit, so the limit counts only the file's own run. The file runs in its
        // own process group (--foreground keeps timeout in it); whatever is left of that group when it exits is killed.
        const bounded = ['timeout', '--foreground', '--kill-after=5s', `${seconds}s`, command, ...parameters];
        const child = spawn(lock ? 'flock' : 'timeout', lock ? [lock, ...bounded] : bounded.slice(1), { cwd: dir, env: { ...process.env, ELPIS_HOME: home,
          EXCALIDRAW_LOCAL_DIR: path.join(home, 'love-spot'), EXCALIDRAW_SCREENSHOTS_DIR: path.join(home, 'Screenshots') }, stdio: ['ignore', output.fd, output.fd], detached: true });
        running = child.pid;
        child.on('error', reject);
        child.on('exit', (status, signal) => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {} resolve(signal ? 1 : status); });
      });
    } finally { await output.close(); }
    const text = await fs.readFile(log, 'utf8');
    const testMs = Number(text.match(/^# duration_ms ([\d.]+)$/m)?.[1] ?? 0);
    summary.testMs += testMs;
    summary.files.push({ name, tier, code, testMs, wallMs: performance.now() - at, log });
    summary.wallMs = performance.now() - started;
    await fs.writeFile(path.join(evidence, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
    console.log(`${code === 0 ? 'PASS' : code === 124 || code === 137 ? 'TIMEOUT' : 'FAIL'} ${name} (${(testMs / 1000).toFixed(2)}s test; ${((performance.now() - at) / 1000).toFixed(2)}s wall; exit ${code}; ${log})`);
    if (code !== 0) { console.error(text.slice(-6000)); process.exitCode = 1; }
    return code;
  }
  // Fast tests import bundled prompts too. Only browser (UI) files need the built renderer.
  if (await run('bridge-resources', process.execPath, ['bridge/build-resources.mts'], 'bridge', { seconds: 120 }) !== 0) return;
  let rendererBuilt = false;
  for (const tier of selected) {
    if (!rendererBuilt && tier === 'ui') {
      // An earlier tier's failure does not stop the UI files.
      if (await run('renderer-build', 'npm', ['run', '-s', 'build'], tier, { seconds: 1200, lock: locks.build }) !== 0) return;
      rendererBuilt = true;
    }
    if (tier === 'ui') {
      // Keep every browser file bounded and serialized with the other workstation workers.
      for (const file of inventory.ui ?? []) await run(file, process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', file], tier, { lock: locks.ui });
    } else {
      for (const file of inventory[tier] ?? []) await run(file, process.execPath, ['--test', '--test-timeout=180000', '--test-reporter=tap', file], tier);
    }
  }
  console.log(`Gate: ${(summary.wallMs / 1000).toFixed(2)}s wall; ${(summary.testMs / 1000).toFixed(2)}s in test runners. ${evidence}/summary.json`);
  // A full, clean, all-green run is recorded for its commit; the desktop install refuses any commit without one.
  const record = passRecord({ start, commit: git(['rev-parse', 'HEAD']), clean: git(['status', '--porcelain', '--untracked-files=no']) === '', selected, tiers, files: summary.files });
  if (record) {
    await fs.mkdir(records, { recursive: true });
    await fs.writeFile(path.join(records, `${record.commit}.json`), JSON.stringify({ ...record, evidence }, null, 2) + '\n');
    console.log(`Recorded a full pass for ${record.commit}.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
