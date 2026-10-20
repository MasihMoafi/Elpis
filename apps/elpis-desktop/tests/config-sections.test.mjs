import test from 'node:test';
import assert from 'node:assert/strict';
import { SECTIONS, configDestination } from '../lib/config-sections.ts';

test('/config resolves the six approved names and common short forms', () => {
  assert.deepEqual(SECTIONS.map(section => section.label), [
    'Models & accounts', 'Permissions & behavior', 'Context & maintenance',
    'Connections & coding', 'App & terminal', 'Advanced',
  ]);
  for (const section of SECTIONS) {
    assert.equal(configDestination(section.label.toUpperCase()), section.id);
    assert.equal(configDestination(section.label.split(' ')[0].toUpperCase()), section.id);
    assert.ok(section.pages.length > 0);
    assert.ok(section.pages.every(page => ['new chats', 'this device'].includes(page.scope)));
  }
  assert.equal(configDestination(), 'sections');
  assert.equal(configDestination('unknown'), 'sections');
});
