import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Commands } from '../bridge/router/infra/commands.mts';
import * as environment from '../bridge/router/infra/environment.mts';

const app = fileURLToPath(new URL('../', import.meta.url));
const trees = new Map<string, ts.SourceFile>();
function scan(directory: string) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory() && !['resources', 'node_modules'].includes(entry.name)) scan(file);
    if (entry.isFile() && /\.[cm]?tsx?$/.test(file) && !/\.(?:test|spec)\./.test(file)) {
      trees.set(file, ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true));
    }
  }
}
for (const directory of ['bridge', 'lib', 'desktop', 'components']) scan(path.join(app, directory));

function runtimeImports(tree: ts.SourceFile): string[] {
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause, bindings = clause?.namedBindings;
      if (!clause?.isTypeOnly && !(bindings && ts.isNamedImports(bindings) && !clause?.name && bindings.elements.every(item => item.isTypeOnly))) imports.push(node.moduleSpecifier.text);
    }
    if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
      && !(node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.every(item => item.isTypeOnly))) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) imports.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return imports;
}

test('desktop feature modules have an acyclic runtime dependency graph', () => {
  const graph = new Map<string, string[]>();
  for (const [file, tree] of trees) graph.set(file, runtimeImports(tree).flatMap(specifier => {
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return [];
    const target = specifier.startsWith('@/') ? path.join(app, specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
    const resolved = [target, ...['.ts', '.mts', '.cts', '.tsx'].map(extension => target + extension), path.join(target, 'index.mts')].find(candidate => trees.has(candidate));
    return resolved ? [resolved] : [];
  }));
  const done = new Set<string>(), stack: string[] = [], cycles: string[] = [];
  const visit = (file: string) => {
    const index = stack.indexOf(file);
    if (index >= 0) { cycles.push([...stack.slice(index), file].map(name => path.relative(app, name)).join(' → ')); return; }
    if (done.has(file)) return;
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop(); done.add(file);
  };
  for (const file of graph.keys()) if (file.startsWith(path.join(app, 'bridge') + path.sep)) visit(file);
  assert.deepEqual(cycles, []);
});

test('source reporting and the health board share one Health contract', () => {
  const owners: string[] = [];
  for (const [file, tree] of trees) if (file.includes(`${path.sep}router${path.sep}`)) {
    for (const statement of tree.statements) if ((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) && statement.name.text === 'Health') owners.push(path.relative(app, file));
  }
  assert.equal(owners.length, 1, owners.join(', '));
});

test('settings projections delegate rollout IO to a dedicated owner', () => {
  const file = path.join(app, 'bridge/elpis-features.mts');
  const imports = runtimeImports(trees.get(file)!);
  assert.deepEqual(imports.filter(name => ['node:fs', 'node:fs/promises', 'node:readline', 'node:zlib'].includes(name)), []);
});

test('the shipped router exposes neither the excluded live transport nor global environment mutation', () => {
  assert.equal('lark' in Commands.prototype, false);
  assert.equal('applyEnvironment' in environment, false);
});
