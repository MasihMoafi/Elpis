// Focused renderer check of the real shared components, like preferences.test.cjs; no app build or bridge.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function components() {
  const root = path.resolve(__dirname, '..'), cache = new Map();
  const load = file => {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
    const local = id => {
      if (!id.startsWith('@/')) return createRequire(file)(id);
      const base = path.join(root, id.slice(2));
      return load(['.ts', '.tsx'].map(extension => base + extension).find(fs.existsSync));
    };
    new Function('require', 'exports', 'module', code)(local, module.exports, module);
    return module.exports;
  };
  return { ...load(path.join(root, 'components/ui/alert-dialog.tsx')), ...load(path.join(root, 'components/ui/button.tsx')) };
}

test('every unavailable primary footer action has a visible, associated reason', () => {
  const { AlertDialogFooter, Button } = components();
  for (const variant of ['default', 'cutPrimary', 'destructive']) {
    const reason = 'Enter a conversation name.';
    const html = renderToStaticMarkup(React.createElement(AlertDialogFooter, null,
      React.createElement(Button, { disabled: true, variant, disabledReason: reason }, 'Save')));
    assert.match(html, /role="status"/);
    const id = html.match(/<p[^>]*id="([^"]+)"[^>]*>Enter a conversation name\.<\/p>/)?.[1];
    assert.ok(id, 'reason must be rendered as visible footer text');
    assert.ok(html.includes(`aria-describedby="${id}"`), 'disabled action must point to its visible explanation');
    assert.doesNotMatch(html, /disabledReason=/, 'reason metadata must not leak to the native button');
  }
});

test('shared reasons appear once, enabled actions have none, and an omitted busy reason is still visible', () => {
  const { AlertDialogFooter, Button } = components();
  const render = children => renderToStaticMarkup(React.createElement(AlertDialogFooter, null, children));
  const busy = render([React.createElement(Button, { key: 'try', variant: 'outline', disabled: true, title: 'Checking build and tests…' }, 'Try it'), React.createElement(Button, { key: 'keep', disabled: true, disabledReason: 'Checking build and tests…' }, 'Keep')]);
  assert.equal(busy.split('>Checking build and tests…</p>').length - 1, 1);
  assert.equal((busy.match(/aria-describedby=/g) || []).length, 2);
  assert.doesNotMatch(render(React.createElement(Button, { disabledReason: 'Describe what should change.' }, 'Start change')), /role="status"|aria-describedby=/);
  assert.match(render(React.createElement(Button, { disabled: true }, 'Saving…')), /Wait for the current action to finish\./);
});
