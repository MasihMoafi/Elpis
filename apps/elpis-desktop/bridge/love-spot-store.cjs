// Shared by the bridge and the standalone window. Every writer takes the same directory lock,
// rereads the drawing, and atomically writes the union, including deletion tombstones.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (message, status = 400) => Object.assign(new Error(message), { status, loveSpot: true });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const newer = (a, b) => a.version > b.version || (a.version === b.version && a.versionNonce < b.versionNonce);
const hash = value => createHash('sha256').update(value).digest('hex');
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
function validate(scene) {
  if (!record(scene) || !Array.isArray(scene.elements) || (scene.files !== undefined && !record(scene.files)) || (scene.appState !== undefined && !record(scene.appState))) throw fail('Invalid drawing');
  for (const e of scene.elements) {
    if (!record(e) || typeof e.id !== 'string' || !e.id || typeof e.type !== 'string' || !Number.isInteger(e.version) || e.version < 1 || !Number.isInteger(e.versionNonce)
      || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(e[key]))) throw fail('Invalid drawing element');
  }
  for (const [id, file] of Object.entries(scene.files ?? {})) {
    if (!record(file) || file.id !== id || typeof file.dataURL !== 'string' || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);/.test(file.dataURL) || typeof file.mimeType !== 'string') throw fail('Invalid drawing image');
  }
  return scene;
}
function merge(current, incoming) {
  const elements = new Map(current.elements.map(e => [e.id, e]));
  for (const e of incoming.elements) if (!elements.has(e.id) || newer(e, elements.get(e.id))) elements.set(e.id, e);
  return { ...current, type: 'excalidraw', version: 2, source: 'Love Spot', elements: [...elements.values()],
    appState: { ...current.appState, ...incoming.appState }, files: { ...incoming.files, ...current.files } };
}
function createLoveSpot({ directory = process.env.EXCALIDRAW_LOCAL_DIR || path.join(os.homedir(), '.local/share/excalidraw-local'), screenshots = path.join(os.homedir(), 'Pictures/Screenshots') } = {}) {
  const sceneFile = path.join(directory, 'scene.excalidraw'), lock = path.join(directory, '.scene-lock'), inbox = path.join(directory, 'inbox');
  let timer, running = false, seen, previous, lastError;
  const listeners = new Set();
  async function read() {
    let text;
    try { text = await fs.readFile(sceneFile, 'utf8'); }
    catch (e) { if (e.code === 'ENOENT') return { scene: { type: 'excalidraw', version: 2, elements: [], files: {}, appState: {} }, revision: hash('') }; throw e; }
    try { return { scene: validate(JSON.parse(text)), revision: hash(text) }; }
    catch { throw fail('The drawing could not be read. It has been left untouched.', 409); }
  }
  async function locked(action) {
    await fs.mkdir(inbox, { recursive: true });
    // A process crash leaves an empty lock. The pid is part of the owner file; only a dead
    // owner (or an empty lock older than 30 seconds) can be recovered.
    const started = Date.now();
    while (true) {
      try { await fs.mkdir(lock); break; }
      catch (e) {
        if (e.code !== 'EEXIST') throw e;
        try {
          const owner = Number(await fs.readFile(path.join(lock, 'owner'), 'utf8'));
          try { process.kill(owner, 0); } catch (probe) { if (probe.code === 'ESRCH') { await fs.unlink(path.join(lock, 'owner')); await fs.rmdir(lock); } }
        } catch (probe) {
          if (probe.code === 'ENOENT') { try { if (Date.now() - (await fs.stat(lock)).mtimeMs > 30000) await fs.rmdir(lock); } catch {} }
        }
        if (Date.now() - started > 5000) throw fail('The drawing is busy. Please retry.', 503);
        await pause(10);
      }
    }
    try { await fs.writeFile(path.join(lock, 'owner'), String(process.pid)); return await action(); }
    finally { await fs.unlink(path.join(lock, 'owner')); await fs.rmdir(lock); }
  }
  async function atomic(file, data) {
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temp, data); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async function save(incoming) {
    validate(incoming);
    return locked(async () => {
      const current = await read(), scene = merge(current.scene, incoming), text = JSON.stringify(scene);
      if (hash(text) !== current.revision) await atomic(sceneFile, text);
      return { scene, revision: hash(text) };
    });
  }
  async function picture({ revision, png } = {}) {
    if (typeof png !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(png)) throw fail('Invalid PNG');
    const bytes = Buffer.from(png, 'base64');
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) throw fail('Invalid PNG');
    return locked(async () => {
      if (revision !== (await read()).revision) throw fail('The drawing changed. Export its current picture.', 409);
      await atomic(path.join(directory, 'view.png'), bytes);
      return { saved: true };
    });
  }
  async function names(dir) { try { return await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  async function importScreenshot(name, bytes) {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG)) return false;
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) return false;
    const id = `shot-${hash(Buffer.concat([Buffer.from(name), bytes])).slice(0, 32)}`, scale = Math.min(1, 1200 / width);
    await locked(async () => {
      const { scene } = await read();
      if (scene.elements.some(e => e.id === id)) return;
      const live = scene.elements.filter(e => !e.isDeleted), now = Date.now();
      const element = { id, type: 'image', fileId: id, version: 1, versionNonce: 0, isDeleted: false,
        x: live.length ? Math.min(...live.map(e => e.x)) : 0, y: live.length ? Math.max(...live.map(e => e.y + e.height)) + 60 : 0,
        width: width * scale, height: height * scale, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1,
        strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, boundElements: null,
        updated: now, link: null, locked: false, status: 'saved', scale: [1, 1], crop: null };
      const file = { id, dataURL: `data:image/png;base64,${bytes.toString('base64')}`, mimeType: 'image/png', created: now, lastRetrieved: now };
      await atomic(sceneFile, JSON.stringify(merge(scene, { elements: [element], files: { [id]: file } })));
    });
    return true;
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      await fs.mkdir(inbox, { recursive: true });
      for (const name of (await names(inbox)).filter(n => n.endsWith('.json')).sort()) {
        const file = path.join(inbox, name);
        let data; try { data = validate(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { continue; }
        await save(data);
        // Commit before consuming. Two readers may both merge the same inbox file; the merge is idempotent.
        await exec('gio', ['trash', file]).catch(async e => { try { await fs.access(file); throw e; } catch (missing) { if (missing.code !== 'ENOENT') throw missing; } });
      }
      for (const name of (await names(screenshots)).filter(n => /\.png$/i.test(n) && !seen.has(n))) {
        let bytes; try { bytes = await fs.readFile(path.join(screenshots, name)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        // Wait for a complete PNG (IEND), so a notification while GNOME is writing retries.
        if (bytes.length >= 12 && bytes.subarray(-8, -4).toString() === 'IEND' && await importScreenshot(name, bytes)) seen.add(name);
      }
      const current = await read();
      if (current.revision !== previous) { previous = current.revision; for (const listen of listeners) listen({ type: 'scene', ...current }); }
      lastError = undefined;
    } catch (e) {
      if (lastError !== e.message) { lastError = e.message; for (const listen of listeners) listen({ type: 'error', message: e.loveSpot ? e.message : 'Love Spot could not sync the drawing.' }); }
    } finally { running = false; }
  }
  async function watch(listen) {
    if (!listeners.size) { seen = new Set(await names(screenshots)); previous = undefined; }
    listeners.add(listen);
    if (!timer) { timer = setInterval(() => void tick(), 150); timer.unref(); }
    try { listen({ type: 'scene', ...await read() }); } catch (e) { listen({ type: 'error', message: e.message }); }
    return () => { listeners.delete(listen); if (!listeners.size) { clearInterval(timer); timer = undefined; } };
  }
  return { read, save, picture, watch, close() { clearInterval(timer); timer = undefined; listeners.clear(); } };
}
module.exports = { createLoveSpot, newer, merge };
