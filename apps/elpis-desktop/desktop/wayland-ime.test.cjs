'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enableWaylandIme } = require('./wayland-ime.cjs');

function commandLine() {
  const switches = [];
  return { switches, appendSwitch: (...args) => switches.push(args) };
}

test('Wayland enables Chromium IME support with text-input-v3; X11 does not', () => {
  const wayland = commandLine();
  enableWaylandIme(wayland, { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' });
  assert.deepEqual(wayland.switches, [['enable-wayland-ime'], ['wayland-text-input-version', '3']]);

  const x11 = commandLine();
  enableWaylandIme(x11, { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: 'wayland-0' });
  assert.deepEqual(x11.switches, []);
});
