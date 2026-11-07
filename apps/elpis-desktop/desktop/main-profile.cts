'use strict';

const path: typeof import('node:path') = require('node:path');
const { openThreadArgument }: typeof import('./open-thread.cts') = require('./open-thread.cts');
const { enableWaylandIme }: typeof import('./wayland-ime.cts') = require('./wayland-ime.cts');

function configureMainProfileImpl({ app, argv = process.argv, env = process.env }: {
    app: import('electron').App,
    argv?: string[],
    env?: NodeJS.ProcessEnv
}) {
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
  // Masih, 7 Nov: standalone Love Spot is its own app ("there we're doing different things"), so its chats, settings
  // and accounts live in its own home and its own runtime, never in Elpis's ~/.elpis-next. Love Spot inside Elpis is unchanged.
  if (loveSpotApp) useLoveSpotHome(env);
  enableWaylandIme(app.commandLine, env);
  // Wayland gives apps global shortcuts only through the desktop portal; Claude's app turns on Chromium's portal support the same way.
  app.commandLine.appendSwitch('enable-features', [app.commandLine.getSwitchValue('enable-features'), 'GlobalShortcutsPortal'].filter(Boolean).join(','));
  const lockData: { openThread: string | null, loveSpot: boolean, workflows?: boolean } = { openThread: openThreadArgument(argv), loveSpot: argv.includes('--love-spot'), ...(argv.includes('--workflows') ? { workflows: true } : {}) };
  return {
    loveSpotApp,
    workflowsApp,
    initialThread: openThreadArgument(argv) as string | null,
    lockData,
  };
}

/** Points the standalone Love Spot at its own Elpis home (an explicit ELPIS_HOME still wins) and drops any inherited
 * bridge endpoint, which would belong to Elpis's runtime. XDG_DATA_HOME is $SNAP_USER_DATA/.local/share inside the snap. */
function useLoveSpotHome(env: NodeJS.ProcessEnv) {
  env.LOVE_SPOT_APP = '1';
  if (!env.ELPIS_HOME) env.ELPIS_HOME = path.join(env.XDG_DATA_HOME || path.join(env.HOME || require('node:os').homedir(), '.local', 'share'), 'love-spot');
  for (const key of ['ELPIS_APP_BRIDGE_SOCKET', 'ELPIS_BRIDGE_SOCKET', 'ELPIS_BRIDGE_URL']) delete env[key];
  // The engine refuses to start without a config file; a fresh install starts with an empty, private one.
  const fs: typeof import('node:fs') = require('node:fs');
  fs.mkdirSync(env.ELPIS_HOME, { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(path.join(env.ELPIS_HOME, 'config.toml'), '', { flag: 'wx', mode: 0o600 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return env.ELPIS_HOME;
}

export declare const configureMainProfile: typeof configureMainProfileImpl;
export declare const loveSpotHome: typeof useLoveSpotHome;
module.exports = { configureMainProfile: configureMainProfileImpl, loveSpotHome: useLoveSpotHome };
