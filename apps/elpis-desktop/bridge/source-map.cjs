'use strict';
const ts = require('typescript');
const path = require('node:path');
/** Stable IDs are relative source names and component names, never workstation paths. */
function instrument(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const edits = [], entries = {};
  function visit(node, component = 'Module') {
    if (ts.isFunctionDeclaration(node) && node.name) component = node.name.text;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) component = node.name.text;
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && /^(?:[a-z]|Button$|Input$|Textarea$)/.test(node.tagName.getText(tree)) && !node.attributes.properties.some(p => p.name?.getText(tree) === 'data-elpis-source')) {
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
function loader(source) {
  const file = path.relative(path.resolve(__dirname, '..'), this.resourcePath).split(path.sep).join('/');
  return instrument(source, file).source;
}
module.exports = loader;
module.exports.instrument = instrument;
