const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { execFileSync } = require('node:child_process');
const data = require('../lib/workflow-sources.json');

// Evaluate the real graph builders; only the desktop storage boundary is replaced.
function load(file, imports) {
  const exports = {}, code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib', file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { exports, require: name => { assert.ok(name in imports, name); return imports[name]; }, crypto: require('node:crypto').webcrypto, console });
  return exports;
}
const canvas = load('canvas.ts', { './agent-characters': load('agent-characters.ts', {}), '@/lib/projects': { appStorage: () => ({ getItem: () => null }) } });
const lab = load('experiment-lab.ts', { '@/lib/canvas': canvas });

test('every actual starter has exactly one evidence entry, valid primary sources and an explicit limitation', () => {
  assert.deepEqual(data.patterns.map(p => p.id).sort(), Array.from(canvas.TEMPLATES, t => t.id).sort());
  assert.equal(new Set(data.patterns.map(p => p.id)).size, data.patterns.length);
  for (const pattern of data.patterns) {
    assert.ok(pattern.proven.length && pattern.unproven.length);
    assert.ok(pattern.sources.length || pattern.status === 'No direct evidence');
    for (const id of pattern.sources) {
      const source = data.sources[id]; assert.ok(source.authors && source.year && source.finding && source.read);
      assert.match(source.url, /^https:\/\/(arxiv.org|aclanthology.org)\//);
    }
  }
  execFileSync(process.execPath, [path.join(__dirname, '../../../scripts/workflow-sources.mjs'), '--check']);
});

test('Lab preserves every starter’s dependency barriers and critiques; multiple sinks receive one synthesis stage', () => {
  for (const template of canvas.TEMPLATES) {
    const graph = template.build(), stages = Array.from(lab.labStages(graph));
    const agents = graph.nodes.filter(n => n.type === 'agent');
    if (!agents.length) { assert.equal(stages.length, 0); continue; }
    for (const agent of agents) {
      const stage = stages.find(s => s.id === agent.id), check = stages.find(s => s.id === `${agent.id}-check`);
      assert.equal(stage.instruction, agent.data.instruction);
      assert.equal(check.kind, 'verify'); assert.deepEqual(Array.from(check.dependsOn), [agent.id]);
      for (const edge of graph.edges.filter(e => e.target === agent.id && e.kind !== 'alongside')) assert.ok(stage.dependsOn.includes(`${edge.source}-check`));
    }
    assert.equal(stages.filter(s => !stages.some(next => next.dependsOn.includes(s.id))).length, 1, template.name);
  }
});

test('comparison means include failed trials, exclude unfinished trials and never replace missing tokens with zero', () => {
  const record = { trials: [
    { arm: 'baseline', passed: true, elapsedMs: 10, tokens: 100, endedAt: 'done' },
    { arm: 'baseline', passed: false, elapsedMs: 30, tokens: null, endedAt: 'done' },
    { arm: 'baseline', passed: false, elapsedMs: 9999, tokens: 9999 },
  ] };
  assert.equal(JSON.stringify(lab.labSummary(record, 'baseline')), JSON.stringify({ count: 2, passed: 1, elapsedMs: 20, tokens: null }));
});
