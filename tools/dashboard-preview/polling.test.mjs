import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../codex-rs/tui/src/dashboard_assets/dashboard.js', import.meta.url), 'utf8');
const token = 'a'.repeat(32);
function harness() {
  const nodes = new Map();
  const writes = [];
  function node(id = '') {
    let text = '';
    return { childNodes: [], disabled: false, className: '',
      get textContent() { return text; },
      set textContent(value) { text = value; writes.push([id, value]); },
      classList: { add() {}, remove() {} },
      replaceChildren() { this.childNodes = []; },
      append(...children) { this.childNodes.push(...children); }
    };
  }
  const state = { schema_version: 1, revision: 1, generated_at: Date.now(), context: {}, tokens: {}, activity: {}, smart_prune: {} };
  let evidence = [{ label: 'Attempt', url: `/evidence/${token}/${'b'.repeat(32)}` }];
  let failed = false;
  const context = vm.createContext({ URLSearchParams, Date, setTimeout() {}, clearTimeout() {},
    location: { hash: `#evidence=${token}` },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); }, createElement() { return node(); } },
    fetch: async path => ({ ok: !failed, json: async () => path === '/data.json' ? { state, heartbeat_at: Date.now() } : evidence })
  });
  // Exercise the actual polling functions without wiring page startup listeners.
  vm.runInContext(source.slice(0, source.indexOf('const tabs =')), context);
  context.seedState = state;
  vm.runInContext('lastValidState = seedState; setTransport("Live", "available");', context);
  writes.length = 0;
  return { context, nodes, writes, fail() { failed = true; }, changeEvidence() { evidence = [{ label: 'Admission', url: `/evidence/${token}/${'c'.repeat(32)}` }]; } };
}
test('background refresh preserves live status and existing evidence links', async () => {
  const h = harness();
  await h.context.poll();
  const link = h.nodes.get('evidence-links').childNodes[0];
  h.writes.length = 0;
  const pending = h.context.poll();
  assert.equal(h.nodes.get('refresh-now').disabled, false, 'background polling must not flash the Refresh button');
  await pending;
  assert.ok(!h.writes.some(([id, value]) => id === 'transport-status' && value === 'Refreshing'), 'background polling must not flash the transport label');
  assert.equal(h.nodes.get('evidence-links').childNodes[0], link, 'unchanged links retain focus and identity');
  h.changeEvidence();
  await h.context.poll();
  assert.equal(h.nodes.get('evidence-links').childNodes[0].textContent, 'Admission', 'new evidence still appears');
});
test('manual refresh remains visible and failed transport is reported', async () => {
  const h = harness();
  const pending = h.context.poll(true);
  assert.equal(h.nodes.get('refresh-now').disabled, true);
  assert.equal(h.nodes.get('transport-status').textContent, 'Refreshing');
  await pending;
  h.fail();
  await h.context.poll();
  assert.equal(h.nodes.get('transport-status').textContent, 'Transport unavailable');
});
