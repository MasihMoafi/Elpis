const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');
const root = path.resolve(__dirname, '..'), cache = new Map();

function source(relative) {
  const file = path.resolve(root, relative);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} }; cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const imports = id => {
    if (!id.startsWith('@/')) return require(id);
    const base = path.join(root, id.slice(2));
    return source(['.tsx', '.ts'].map(ext => base + ext).find(file => fs.existsSync(file)));
  };
  new Function('require', 'module', 'exports', code)(imports, module, module.exports);
  return module.exports;
}

test('POLISH source: all native disclosures use the shared summary and Lucide chevron', () => {
  const owners = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.name.endsWith('.tsx') && /<summary\b/.test(fs.readFileSync(file, 'utf8'))) owners.push(path.relative(root, file));
    }
  };
  visit(path.join(root, 'app')); visit(path.join(root, 'components'));
  assert.deepEqual(owners, ['components/ui/disclosure-summary.tsx']);
  const { DisclosureSummary } = source('components/ui/disclosure-summary.tsx');
  const html = renderToStaticMarkup(React.createElement(DisclosureSummary, { className: 'step-head', 'aria-expanded': true, title: 'Open details' }, 'A long عنوان '.repeat(20)));
  assert.match(html, /<summary[^>]*class="disclosure-summary step-head"[^>]*aria-expanded="true"/);
  assert.match(html, /lucide-chevron-right[^>]*aria-hidden="true"/);
  assert.match(html, /<path d="m9 18 6-6-6-6"/);
  assert.doesNotMatch(html, /[▼▶▾▸▲◀◂▴]/);
  assert.match(html, /A long عنوان/);
});

test('POLISH source: Base UI selects receive a chevron as their actual child', () => {
  const { Select, SelectTrigger, SelectValue } = source('components/ui/select.tsx');
  const html = renderToStaticMarkup(React.createElement(Select, null,
    React.createElement(SelectTrigger, { 'aria-label': 'Model' }, React.createElement(SelectValue, null, 'Default'))));
  assert.match(html, /lucide-chevron-down/);
  assert.match(html, /<path d="m6 9 6 6 6-6"/);
  assert.doesNotMatch(html, /[▼▶▾▸▲◀◂▴]/);
});

