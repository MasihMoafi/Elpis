// Upgrade the existing standalone Love Spot to the same merge/watch protocol as Elpis.
// No packages are installed. The standalone app's existing build script rebuilds its renderer.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export async function syncLoveSpot(directory, { build = true } = {}) {
  const read = name => fs.readFile(path.join(directory, name), 'utf8');
  const replace = (text, from, to) => {
    if (!text.includes(from)) throw new Error('Standalone Love Spot source changed; review the integration before updating it.');
    return text.replace(from, to);
  };
  let main = await read('main.cjs'), preload = await read('preload.cjs'), renderer = await read('src/app.jsx');
  if (!main.includes("require('./love-spot-store.cjs')")) {
    main = replace(main, "const fs = require('node:fs'), path = require('node:path');", "const fs = require('node:fs'), path = require('node:path');\nconst { createLoveSpot } = require('./love-spot-store.cjs');");
    main = replace(main, "  ipcMain.handle('load', () => { try { return fs.readFileSync(SCENE, 'utf8'); } catch { return null; } });\n  ipcMain.handle('save', (_event, text) => { if (typeof text === 'string') write(SCENE, text); });\n  ipcMain.handle('view', (_event, bytes) => { if (bytes instanceof Uint8Array) write(VIEW, Buffer.from(bytes)); });",
      "  const board = createLoveSpot({ directory: DIR, screenshots: path.join(app.getPath('pictures'), 'Screenshots') });\n  ipcMain.handle('load', async () => { const data = await board.read(); return JSON.stringify({ ...data.scene, revision: data.revision }); });\n  ipcMain.handle('save', (_event, text) => board.save(JSON.parse(text)));\n  ipcMain.handle('view', (_event, bytes, revision) => board.picture({ revision, png: Buffer.from(bytes).toString('base64') }));\n  app.on('before-quit', () => board.close());");
    const start = main.indexOf('  // A screenshot taken while the app is open'), end = main.indexOf('\n};\n(async () =>', start);
    if (start < 0 || end < 0) throw new Error('Standalone watcher changed; review the integration.');
    main = main.slice(0, start) + "  win.webContents.once('did-finish-load', () => board.watch(value => {\n    if (value.type === 'scene') win?.webContents.send('incoming', { ...value.scene, revision: value.revision });\n    else console.error(value.message);\n  }));" + main.slice(end);
    // The shared store owns atomic writes and paths now.
    main = replace(main, "const SCENE = path.join(DIR, 'scene.excalidraw'), VIEW = path.join(DIR, 'view.png'), INBOX = path.join(DIR, 'inbox');\nconst write = (file, data) => { const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, data); fs.renameSync(temp, file); };", "const INBOX = path.join(DIR, 'inbox');");
    preload = replace(preload, "view: bytes => ipcRenderer.invoke('view', bytes)", "view: (bytes, revision) => ipcRenderer.invoke('view', bytes, revision)");
    renderer = replace(renderer, 'const board = window.board;', 'const board = window.board;\nlet revision = null; // Shared-store revision guards whole-drawing PNG exports.');
    renderer = replace(renderer, '    board.onIncoming(data => {', '    board.onIncoming(data => {\n      revision = data.revision ?? revision;');
    renderer = replace(renderer, '      for (const element of restoreElements', "      const screenshot = (data.elements || []).find(e => e.type === 'image' && !e.isDeleted && e.id.startsWith('shot-') && !shown.has(e.id));\n      let changed = false;\n      for (const element of restoreElements");
    renderer = replace(renderer, '        if (!mine || newer(element, mine)) shown.set(element.id, element);', '        if (!mine || newer(element, mine)) { shown.set(element.id, element); changed = true; }');
    renderer = replace(renderer, '      excalidraw.updateScene({ elements: [...shown.values()] });', "      if (changed) excalidraw.updateScene({ elements: [...shown.values()] });\n      if (screenshot) { excalidraw.updateScene({ appState: { selectedElementIds: { [screenshot.id]: true } } }); excalidraw.scrollToContent(screenshot, { fitToViewport: true, viewportZoomFactor: 0.9 }); }");
    const shotStart = renderer.indexOf('    // A new screenshot goes under everything'), shotEnd = renderer.indexOf('\n  };\n  const changed', shotStart);
    if (shotStart < 0 || shotEnd < 0) throw new Error('Standalone screenshot handler changed; review the integration.');
    renderer = renderer.slice(0, shotStart) + renderer.slice(shotEnd);
    renderer = replace(renderer, "board.save(serializeAsJSON(elements, appState, files, 'local'))", "board.save(JSON.stringify({ ...JSON.parse(serializeAsJSON(elements, appState, files, 'local')), elements: api.current?.getSceneElementsIncludingDeleted() || elements, files })).then(data => { revision = data.revision; }).catch(console.error)");
    renderer = replace(renderer, '      const blob = await exportToBlob', '      const exportedRevision = revision;\n      const blob = await exportToBlob');
    renderer = replace(renderer, '      if (!live.length) return;\n', '');
    renderer = replace(renderer, 'board.view(new Uint8Array(await blob.arrayBuffer()));', 'board.view(new Uint8Array(await blob.arrayBuffer()), exportedRevision).catch(console.error);');
    renderer = replace(renderer, '  const initial = data &&', '  revision = data?.revision ?? null;\n  const initial = data &&');
    // All matching is completed before writing any source.
    await fs.writeFile(path.join(directory, 'main.cjs'), main);
    await fs.writeFile(path.join(directory, 'preload.cjs'), preload);
    await fs.writeFile(path.join(directory, 'src/app.jsx'), renderer);
  }
  if (!renderer.includes('// Love Spot pages protocol.') && (!renderer.includes('getSceneElementsIncludingDeleted') || !renderer.includes('board.onIncoming'))) throw new Error('Standalone renderer changed; review the pages integration before updating it.');
  await fs.copyFile(new URL('./love-spot-standalone.jsx', import.meta.url), path.join(directory, 'src/app.jsx'));
  await fs.copyFile(new URL('../lib/love-spot.ts', import.meta.url), path.join(directory, 'src/love-spot.ts'));
  await fs.copyFile(new URL('../bridge/love-spot-store.cjs', import.meta.url), path.join(directory, 'love-spot-store.cjs'));
  if (build) await promisify(execFile)(process.execPath, ['build.mjs'], { cwd: directory });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncLoveSpot(process.argv[2] ?? path.join(os.homedir(), '.local/lib/excalidraw-local'));
  process.stdout.write('Standalone Love Spot now uses the shared drawing store. Reopen its window to load the change.\n');
}
