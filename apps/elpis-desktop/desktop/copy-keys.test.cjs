const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { registerCopyKeys } = require('./copy-keys.cjs');

test('Ctrl+Shift+C copies the selection, as in a terminal; other keys pass through', () => {
  const contents = new EventEmitter(); let copies = 0; contents.copy = () => copies++;
  registerCopyKeys(contents);
  const press = (key, mods = {}) => { let stopped = false; contents.emit('before-input-event', { preventDefault: () => { stopped = true; } }, { type: 'keyDown', key, control: false, shift: false, alt: false, meta: false, ...mods }); return stopped; };
  assert.equal(press('C', { control: true, shift: true }), true); assert.equal(copies, 1);
  assert.equal(press('c', { control: true }), false, 'plain Ctrl+C stays with Chromium');
  assert.equal(press('C', { control: true, shift: true, alt: true }), false);
  assert.equal(press('V', { control: true, shift: true }), false);
  assert.equal(copies, 1);
});
