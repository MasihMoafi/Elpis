const ts = require('typescript');

module.exports = function transpile(source) {
  return ts.transpileModule(source, {
    fileName: this.resourcePath,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
};
