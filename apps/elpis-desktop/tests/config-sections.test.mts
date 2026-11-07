import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, configDestination } from '../lib/config-sections.ts';

test('/config resolves category aliases directly to working settings pages', () => {
  assert.deepEqual(SECTIONS.map(section => section.label), [
    'Personal', 'Integrations', 'Coding', 'Archived',
    'Models & accounts', 'Permissions & behavior', 'Context & maintenance',
    'Connections & coding', 'App & terminal', 'Advanced',
  ]);
  const destinations = ['general', 'mcp', 'hooks', 'archived', 'providers', 'configuration', 'personalization', 'mcp', 'general', 'configuration'];
  for (const [index, section] of SECTIONS.entries()) {
    assert.equal(configDestination(section.label.toUpperCase()), destinations[index]);
    const firstWord = section.label.split(' ')[0];
    assert.ok(firstWord);
    assert.equal(configDestination(firstWord.toUpperCase()), destinations[index]);
    assert.equal(configDestination(section.id), destinations[index]);
  }
  assert.equal(configDestination(), 'configuration');
  assert.equal(configDestination('unknown'), 'configuration');
});
