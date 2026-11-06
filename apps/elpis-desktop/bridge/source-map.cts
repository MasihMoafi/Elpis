'use strict';
import type * as TypeScript from 'typescript';
const ts: typeof TypeScript = require('typescript');
const path = require('node:path');
/** Stable IDs are relative source names and component names, never workstation paths. */
function instrumentImpl(source: string, file: string) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits: { at: number; text: string }[] = [], entries: Record<string, { component: string; file: string }> = {};
  function visit(node: TypeScript.Node, component = 'Module') {
    if (ts.isFunctionDeclaration(node) && node.name) component = node.name.text;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) component = node.name.text;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^(?:[a-z]|Button$|Input$|Textarea$)/.test(node.tagName.getText(tree)) && !node.attributes.properties.some(p => 'name' in p && p.name?.getText(tree) === 'data-elpis-source')) {
      const id = `${file}#${component}`;
      entries[id] = { component, file: `apps/elpis-desktop/${file}` };
      edits.push({ at: node.tagName.end, text: ` data-elpis-source=${JSON.stringify(id)}` });
    }
    ts.forEachChild(node, child => visit(child, component));
  }
  visit(tree);
  for (const { at, text } of edits.sort((a, b) => b.at - a.at)) source = source.slice(0, at) + text + source.slice(at);
  return { source, entries };
}
function loader(this: { resourcePath: string }, source: string) {
  const file = path.relative(path.resolve(__dirname, '..'), this.resourcePath).split(path.sep).join('/');
  return instrumentImpl(source, file).source;
}
module.exports = loader;
export declare const instrument: typeof instrumentImpl;
module.exports.instrument = instrumentImpl;
