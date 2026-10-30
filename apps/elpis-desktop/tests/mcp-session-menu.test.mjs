import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { transpileModule, ModuleKind, JsxEmit, ScriptTarget } from 'typescript';

const require = createRequire(import.meta.url), root = path.resolve(import.meta.dirname, '..');
function fixture(api) {
  const slots = [], pending = [];
  let cursor = 0;
  const hooks = {
    useState(initial) {
      const key = cursor++;
      if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial;
      return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }];
    },
    useEffect(effect, deps) {
      const key = cursor++, old = slots[key];
      if (!old || !deps || deps.some((value, index) => !Object.is(value, old.deps[index]))) {
        slots[key] = { deps, cleanup: old?.cleanup };
        pending.push(() => { old?.cleanup?.(); slots[key].cleanup = effect(); });
      }
    },
  };
  const filename = path.join(root, 'components/mcp-session-menu.tsx');
  const source = readFileSync(filename, 'utf8');
  const code = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.ReactJSX, target: ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  const localRequire = id => {
    if (id === 'react') return hooks;
    if (id === '@/lib/api') return { api };
    if (id === 'lucide-react') return { Check: 'span', ChevronDown: 'span', Plug: 'span' };
    if (id === '@/components/ui/dropdown-menu') return Object.fromEntries(['DropdownMenu', 'DropdownMenuContent', 'DropdownMenuItem', 'DropdownMenuTrigger'].map(name => [name, 'div']));
    return require(id);
  };
  new Function('require', 'exports', 'module', code)(localRequire, module.exports, module);
  const Component = module.exports.McpSessionMenu;
  return {
    render(props) { cursor = 0; return Component(props); },
    effects() { for (const run of pending.splice(0)) run(); },
    dispose() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('MCP menu reloads the catalog when the draft project changes', async () => {
  const calls = [];
  const view = fixture(async route => { calls.push(route); return { servers: [] }; });
  try {
    view.render({ cwd: '/work/project-a', onChange() {} }); view.effects();
    await new Promise(setImmediate);
    view.render({ cwd: '/work/project-b', onChange() {} }); view.effects();
    await new Promise(setImmediate);
    view.render({ onChange() {} }); view.effects();
    await new Promise(setImmediate);
    assert.deepEqual(calls, ['/mcp?cwd=%2Fwork%2Fproject-a', '/mcp?cwd=%2Fwork%2Fproject-b', '/mcp']);
  } finally { view.dispose(); }
});
