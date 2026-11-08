const { test } = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');
const data: typeof import('../lib/workflow-sources.json') = require('../lib/workflow-sources.json');

// Evaluate the real graph builders; only the desktop storage boundary is replaced.
const modules = new Map<string, object>();
function load<T>(file: string): T {
  const filename = path.resolve(__dirname, '../lib', file.endsWith('.ts') ? file : `${file}.ts`);
  if (modules.has(filename)) return modules.get(filename) as T;
  const exports = {}, code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  modules.set(filename, exports);
  vm.runInNewContext(code, { exports, require: (name: string) => {
    if (name === '@/lib/projects') return { appStorage: () => ({ getItem: () => null }) };
    assert.ok(name.startsWith('.') || name.startsWith('@/lib/'), name);
    return load(name.startsWith('@/lib/') ? name.slice(6) : path.resolve(path.dirname(filename), name));
  }, crypto: require('node:crypto').webcrypto, console });
  return exports as T;
}
const canvas = load<typeof import('../lib/canvas')>('canvas.ts');
const lab = load<typeof import('../lib/experiment-lab')>('experiment-lab.ts');

test('every actual starter has exactly one evidence entry, valid primary sources and an explicit limitation', () => {
  assert.deepEqual(data.patterns.map(p => p.id).sort(), Array.from(canvas.TEMPLATES, t => t.id).sort());
  assert.equal(new Set(data.patterns.map(p => p.id)).size, data.patterns.length);
  for (const pattern of data.patterns) {
    assert.ok(pattern.proven.length && pattern.unproven.length);
    assert.ok(pattern.sources.length || pattern.status === 'No direct evidence');
    for (const id of pattern.sources) {
      const source = (data.sources as Record<string, { authors: string; year: number; finding: string; read: string; url: string }>)[id]; assert.ok(source && source.authors && source.year && source.finding && source.read);
      assert.match(source.url, /^https:\/\/(arxiv.org|aclanthology.org)\//);
    }
  }
  execFileSync(process.execPath, [path.join(__dirname, '../../../scripts/workflow-sources.mts'), '--check']);
});

test('Lab preserves every starter’s dependency barriers and critiques; multiple sinks receive one synthesis stage', () => {
  for (const template of canvas.TEMPLATES) {
    const graph = template.build(), stages = Array.from(lab.labStages(graph));
    const agents = graph.nodes.filter(n => n.type === 'agent');
    if (!agents.length) { assert.equal(stages.length, 0); continue; }
    for (const agent of agents) {
      const stage = stages.find(s => s.id === agent.id), check = stages.find(s => s.id === `${agent.id}-check`);
      assert.ok(stage && check);
      assert.equal(stage.instruction, agent.data.instruction);
      assert.equal(check.kind, 'verify'); assert.deepEqual(Array.from(check.dependsOn), [agent.id]);
      for (const edge of graph.edges.filter(e => e.target === agent.id && e.kind !== 'alongside')) assert.ok(stage.dependsOn.includes(`${edge.source}-check`));
    }
    assert.equal(stages.filter(s => !stages.some(next => next.dependsOn.includes(s.id))).length, 1, template.name);
  }
});

test('comparison means include failed trials, exclude unfinished trials and never replace missing tokens with zero', () => {
  const trial = { arm: 'baseline' as const, repetition: 1, answer: '', error: null, steps: [] };
  const record: import('../lib/experiment-lab').LabRecord = { version: 1, id: 'test', status: 'running', startedAt: 'start', model: 'test', request: { pattern: '', task: '', expected: '', repetitions: 1, stages: [] }, error: null, trials: [
    { ...trial, passed: true, elapsedMs: 10, tokens: 100, endedAt: 'done' },
    { ...trial, passed: false, elapsedMs: 30, tokens: null, endedAt: 'done' },
    { ...trial, passed: false, elapsedMs: 9999, tokens: 9999 },
  ] };
  assert.equal(JSON.stringify(lab.labSummary(record, 'baseline')), JSON.stringify({ count: 2, passed: 1, elapsedMs: 20, tokens: null }));
});
