// Focused source regression for the actual SettingsView save transaction. Renderer and real-app checks are separate.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { transpileModule, ModuleKind, JsxEmit } = require('typescript');
const { arrange, move } = require('../lib/nav-order.ts');
const { SECTIONS } = require('../lib/config-sections.ts');

function view(saved = {}) {
  let preferences = { settingsSectionOrder: '', settingsPageOrder: '', settingsPageGroups: '{}', ...saved };
  let options, refused = false;
  const patches = [];
  const empty = new Proxy({}, { get: (_, key) => key === '__esModule' ? true : () => null });
  const imports = id => {
    if (id === 'react') return { useState: initial => [initial, () => {}], useEffect: () => {} };
    if (id === '@/lib/preferences') return { usePreferences: () => preferences, savePreferences: patch => {
      if (refused) throw Error('Store refused');
      patches.push(patch); preferences = { ...preferences, ...patch };
    } };
    if (id === '@/components/reorder') return { ReorderItem: 'reorder', useReorder: config => { options = config; return {}; } };
    if (id === '@/lib/nav-order') return { arrange, move };
    if (id === '@/lib/config-sections') return { SECTIONS };
    if (id.startsWith('@/')) return empty;
    return require(id);
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../components/settings-view.tsx'), 'utf8');
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(imports, module, module.exports);
  const render = () => {
    const tree = module.exports.SettingsView({ accountRefresh: 0, theme: 'light' });
    const groups = tree.props.children[0].props.children.find(child => child?.props?.role === 'tablist').props.children[0];
    return Object.fromEntries(groups.map(group => [group.key, group.props.children[1].map(page => page.key)]));
  };
  return { render, options: () => options, patches, refuse: () => { refused = true; } };
}

test('SETTINGS source: every page accepts every group including empty groups, and saves membership and position together', () => {
  const f = view(), initial = f.render(), ids = Object.values(initial).flat();
  assert.equal(f.options().order('archived').at(-1), 'advanced', 'keyboard order includes the empty last group');
  for (const id of ids) for (const group of SECTIONS) {
    f.render();
    assert.equal(f.options().canDrop(id, group.id), true);
    f.options().onMove(id, { target: group.id, after: false, into: true });
    const after = f.render();
    assert.equal(after[group.id].at(-1), id);
    assert.equal(Object.values(after).flat().length, ids.length);
    assert.deepEqual(Object.keys(f.patches.at(-1)).sort(), ['settingsPageGroups', 'settingsPageOrder']);
  }
});
