'use strict';

const path = require('node:path');
const { openThreadArgument } = require('./open-thread.cjs');
const { enableWaylandIme } = require('./wayland-ime.cts');

/**
 * @param {{
 *   app: import('electron').App,
 *   argv?: string[],
 *   env?: NodeJS.ProcessEnv
 * }} options
 */
function configureMainProfile({ app, argv = process.argv, env = process.env }) {
  // WM_CLASS comes from package.json "name" (elpis-desktop) when launched as the app directory;
  // elpis-desktop.desktop.in sets StartupWMClass=elpis-desktop to match, so docks show the Elpis icon.
  // --love-spot-app (the Love Spot dock icon): Love Spot as its own app, so its window groups under that icon. Wayland
  // takes the app id from the desktop name; its own profile gives it its own single-instance lock.
  const loveSpotApp = argv.includes('--love-spot-app');
  const workflowsApp = argv.includes('--workflows-app');
  app.setName(loveSpotApp ? 'Love Spot' : workflowsApp ? 'Elpis Workflows' : 'Elpis');
  if (loveSpotApp) app.setDesktopName('excalidraw.desktop');
  else if (workflowsApp) app.setDesktopName('elpis-workflows.desktop');
  app.setPath('userData', env.ELPIS_DESKTOP_PROFILE || path.join(app.getPath('appData'), loveSpotApp ? 'Elpis Love Spot' : workflowsApp ? 'Elpis Workflows' : 'Elpis'));
  enableWaylandIme(app.commandLine, env);
  // Wayland gives apps global shortcuts only through the desktop portal; Claude's app turns on Chromium's portal support the same way.
  app.commandLine.appendSwitch('enable-features', [app.commandLine.getSwitchValue('enable-features'), 'GlobalShortcutsPortal'].filter(Boolean).join(','));
  /** @type {{ openThread: string | null, loveSpot: boolean, workflows?: boolean }} */
  const lockData = { openThread: openThreadArgument(argv), loveSpot: argv.includes('--love-spot'), ...(argv.includes('--workflows') ? { workflows: true } : {}) };
  return {
    loveSpotApp,
    workflowsApp,
    initialThread: /** @type {string | null} */ (openThreadArgument(argv)),
    lockData,
  };
}

module.exports = { configureMainProfile };
