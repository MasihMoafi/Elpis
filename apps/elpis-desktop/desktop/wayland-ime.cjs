'use strict';

function enableWaylandIme(commandLine, env = process.env) {
  const wayland = env.XDG_SESSION_TYPE ? env.XDG_SESSION_TYPE === 'wayland' : !!env.WAYLAND_DISPLAY;
  if (!wayland) return;
  commandLine.appendSwitch('enable-wayland-ime');
  commandLine.appendSwitch('wayland-text-input-version', '3');
}

module.exports = { enableWaylandIme };
