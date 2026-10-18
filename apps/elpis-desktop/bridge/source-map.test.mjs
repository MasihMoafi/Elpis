import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { instrument } = createRequire(import.meta.url)('./source-map.cjs');
test('build map and DOM IDs share component provenance, including arrow components and shared controls', () => {
  const { source, entries } = instrument('export function Pane(){return <section><Button/><span>Hi</span></section>} const Row=()=> <div/>;', 'components/pane.tsx');
  assert.match(source, /section data-elpis-source="components\/pane.tsx#Pane"/);
  assert.match(source, /div data-elpis-source="components\/pane.tsx#Row"/);
  assert.ok(source.includes('<Button data-elpis-source="components/pane.tsx#Pane"/>'));
  assert.deepEqual(entries['components/pane.tsx#Pane'], { component: 'Pane', file: 'apps/elpis-desktop/components/pane.tsx' });
});
