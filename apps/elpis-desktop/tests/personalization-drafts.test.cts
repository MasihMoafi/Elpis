const { compileFunction }: typeof import('node:vm') = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { transpileModule, ModuleKind, ScriptTarget } = require('typescript');
function load(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
  const listeners: { beforeunload: (event: { preventDefault(): void }) => void } = { beforeunload: () => { throw Error('listener not installed'); } };
  const window = { addEventListener: (event: 'beforeunload', fn: typeof listeners.beforeunload) => { listeners[event] = fn; }, __elpisFlushSettings: () => { throw Error('flush not installed'); } };
  const module = { exports: {} };
  const code = transpileModule(fs.readFileSync(require('node:path').join(__dirname, '../lib/personalization-drafts.ts'), 'utf8'), { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 } }).outputText;
  compileFunction(code, ['require', 'module', 'exports', 'window'])(() => ({ appStorage: () => storage }), module, module.exports, window);
  return { ...module.exports as typeof import('../lib/personalization-drafts.ts'), window, listeners };
}
test('file drafts survive module reload, ask before leaving, and recover after the store refuses writes', () => {
  const values = new Map<string, string>(); let refuse = false;
  const storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { if (refuse) throw Error('disk full'); values.set(key, value); }, removeItem: key => { values.delete(key); } };
  const first = load(storage), key = 'elpis-draft-v1:settings-instructions', draft = { version: 'v1', content: 'unsaved فارسی' };
  first.writePersonalizationDraft(key, draft);
  const reopened = load(storage); assert.deepEqual(reopened.readPersonalizationDraft(key), draft);
  let prompted = false; reopened.listeners.beforeunload({ preventDefault: () => { prompted = true; } }); assert.equal(prompted, true);
  refuse = true;
  const newer = { ...draft, content: 'keep after failed journal' };
  assert.throws(() => reopened.writePersonalizationDraft(key, newer), /disk full/);
  assert.deepEqual(reopened.readPersonalizationDraft(key), newer);
  assert.equal(reopened.window.__elpisFlushSettings(), false);
  refuse = false; assert.equal(reopened.window.__elpisFlushSettings(), true);
  assert.deepEqual(load(storage).readPersonalizationDraft(key), newer);
  reopened.writePersonalizationDraft(key, null); prompted = false;
  reopened.listeners.beforeunload({ preventDefault: () => { prompted = true; } }); assert.equal(prompted, false);
  assert.equal(load(storage).readPersonalizationDraft(key), null);
});
