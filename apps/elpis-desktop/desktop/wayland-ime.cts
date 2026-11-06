'use strict';

function applyWaylandIme(commandLine: { appendSwitch: (name: string, value?: string) => void }, env: NodeJS.ProcessEnv = process.env) {
  const wayland = env.XDG_SESSION_TYPE ? env.XDG_SESSION_TYPE === 'wayland' : !!env.WAYLAND_DISPLAY;
  if (!wayland) return;
  commandLine.appendSwitch('enable-wayland-ime');
  commandLine.appendSwitch('wayland-text-input-version', '3');
}

export declare const enableWaylandIme: typeof applyWaylandIme;
module.exports = { enableWaylandIme: applyWaylandIme };
