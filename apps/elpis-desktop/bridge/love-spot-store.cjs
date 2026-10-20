// Shared by the bridge and the standalone window. Every writer takes the same directory lock,
// rereads the drawing, and atomically writes the union, including deletion tombstones.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { newer } = require('./love-spot-order.cjs');
const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = (message, status = 400) => Object.assign(new Error(message), { status, loveSpot: true });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
async function trashFile(file) {
  await exec('gio', ['trash', file]).catch(async e => { try { await fs.access(file); throw e; } catch (missing) { if (missing.code !== 'ENOENT') throw missing; } });
}
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const screenshotId = (name, bytes) => `shot-${hash(Buffer.concat([Buffer.from(name), bytes])).slice(0, 32)}`;
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
  const files = { ...incoming.files, ...current.files };
  // A normalized image replaces its original, but a stale window cannot put the large bytes back.
  for (const [id, file] of Object.entries(incoming.files ?? {})) {
    if (!files[id] || (file.loveSpotResized && !files[id].loveSpotResized) || (file.loveSpotResized === files[id].loveSpotResized && file.dataURL.length < files[id].dataURL.length)) files[id] = file;
  }
  const referenced = new Set([...elements.values()].filter(e => !e.isDeleted && e.fileId).map(e => e.fileId));
  return { ...current, type: 'excalidraw', version: 2, source: 'Love Spot', elements: [...elements.values()],
    appState: { ...current.appState, ...incoming.appState }, files: Object.fromEntries(Object.entries(files).filter(([id]) => referenced.has(id))) };
}
function createLoveSpot({ directory = process.env.EXCALIDRAW_LOCAL_DIR || path.join(os.homedir(), '.local/share/excalidraw-local'), screenshots = process.env.EXCALIDRAW_SCREENSHOTS_DIR || path.join(os.homedir(), 'Pictures/Screenshots') } = {}) {
  const sceneFile = path.join(directory, 'scene.excalidraw'), lock = path.join(directory, '.scene-lock'), inbox = path.join(directory, 'inbox'), pages = path.join(directory, 'pages');
  const choicesFile = path.join(directory, '.screenshot-choices.json');
  // Same-user local IPC keeps private trays available to a later dock process
  // without journaling screenshot names or pixels to the board directory.
  const peerDirectory = path.join(os.tmpdir(), `elpis-shots-${process.getuid?.() ?? 'user'}-${hash(path.resolve(directory)).slice(0, 16)}`);
  const peerSocket = path.join(peerDirectory, `${randomUUID()}.sock`), sockets = new Set();
  const trayError = 'Love Spot could not sync its private screenshot trays between windows. It will retry.';
  let peerServer, peerError, nextPeerAttempt = 0;
  let timer, starting, closed = false, running = false, seen, previous, sceneStamp, lastError, syncError;
  const listeners = new Set();
  // Pending pixels stay in memory. Only explicit choices persist as opaque IDs,
  // so separate app processes cannot offer an already placed/dismissed screenshot.
  const pending = new Map();
  function track(socket) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; }
  async function shareScreenshots() {
    peerServer = net.createServer(socket => {
      track(socket).setTimeout(5000, () => socket.destroy()); socket.on('error', () => {});
      let input = '';
      socket.on('data', chunk => {
        input += chunk;
        if (input.length > 1024 * 1024) return socket.destroy();
        if (!input.includes('\n')) return;
        try {
          const ids = JSON.parse(input.trim());
          if (!Array.isArray(ids)) return socket.destroy();
          const known = new Set(ids), batch = []; let bytesInBatch = 0;
          for (const shot of pending.values()) {
            if (known.has(shot.id)) continue;
            if (batch.length && bytesInBatch + shot.bytes.length > 4 * 1024 * 1024) break;
            batch.push({ id: shot.id, name: shot.name, data: shot.bytes.toString('base64'), modified: shot.modified });
            bytesInBatch += shot.bytes.length;
          }
          socket.end(JSON.stringify(batch));
        } catch { socket.destroy(); }
      });
    });
    await fs.mkdir(peerDirectory, { recursive: true, mode: 0o700 });
    await new Promise((resolve, reject) => { peerServer.once('error', reject); peerServer.listen(peerSocket, resolve); });
    peerServer.unref();
  }
  async function receiveScreenshots() {
    let peers;
    try { peers = (await names(peerDirectory)).filter(name => name.endsWith('.sock') && name !== path.basename(peerSocket)); peerError = undefined; }
    catch { peerError = trayError; return false; }
    const replies = await Promise.all(peers.map(name => new Promise(resolve => {
      const socket = track(net.createConnection(path.join(peerDirectory, name)));
      let data = '', settled = false;
      const finish = shots => { if (!settled) { settled = true; resolve(shots); socket.destroy(); } };
      socket.setTimeout(5000, () => finish([])); socket.on('error', () => finish([]));
      socket.once('connect', () => socket.write(`${JSON.stringify([...pending.keys()])}\n`));
      socket.on('data', chunk => { data += chunk; });
      socket.on('end', () => { try { const shots = JSON.parse(data); finish(Array.isArray(shots) ? shots : []); } catch { finish([]); } });
      socket.on('close', () => finish([]));
    })));
    let added = false;
    for (const shots of replies) for (const shot of shots) {
      if (!record(shot) || typeof shot.name !== 'string' || typeof shot.data !== 'string' || !Number.isFinite(shot.modified)) continue;
      const bytes = Buffer.from(shot.data, 'base64');
      if (shot.id !== screenshotId(shot.name, bytes) || pending.has(shot.id)) continue;
      pending.set(shot.id, { id: shot.id, name: shot.name, bytes, modified: shot.modified }); added = true;
    }
    return added;
  }
  async function ensureSharing() {
    if (closed || peerServer?.listening || Date.now() < nextPeerAttempt) return;
    nextPeerAttempt = Date.now() + 1000;
    try { await shareScreenshots(); peerError = undefined; }
    catch { peerError = trayError; }
  }
  async function screenshotChoices() {
    try {
      const ids = JSON.parse(await fs.readFile(choicesFile, 'utf8'));
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !/^shot-[a-f0-9]{32}$/.test(id))) throw fail('Screenshot choices could not be read. Please retry.', 409);
      return new Set(ids);
    } catch (e) { if (e.code === 'ENOENT') return new Set(); throw e; }
  }
  const screenshotsList = () => [...pending.values()].sort((a, b) => b.modified - a.modified || b.name.localeCompare(a.name))
    .map(({ id, name, bytes }) => ({ id, name, dataURL: `data:image/png;base64,${bytes.toString('base64')}` }));
  function publishScreenshots() {
    const update = { type: 'screenshots', screenshots: screenshotsList() };
    for (const listen of listeners) listen(update);
  }
  async function read() {
    let text;
    try { text = await fs.readFile(sceneFile, 'utf8'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    try {
      const scene = text === undefined ? { type: 'excalidraw', version: 2, elements: [], files: {}, appState: {} } : validate(JSON.parse(text));
      if (!scene.page) {
        const existing = new Set(await names(pages)); let name = 'Current page', suffix = 2;
        while (existing.has(`${name}.excalidraw`)) name = `Current page ${suffix++}`;
        scene.page = { name, session: 'legacy' };
      }
      pageName(scene.page.name);
      if (typeof scene.page.session !== 'string' || !scene.page.session) throw fail('Invalid page');
      return { scene, revision: hash(text ?? '') };
    }
    catch { throw fail('The drawing could not be read. It has been left untouched.', 409); }
  }
  function pageName(name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 100 || /[/\\\x00-\x1f]/.test(name) || /^\.+$/.test(name)) throw fail('Use a page name of 1–100 characters without slashes.');
    return name;
  }
  const pageFile = name => path.join(pages, `${pageName(name)}.excalidraw`);
  function samePage(incoming, current) {
    if ((incoming && incoming.session !== current.session) || (!incoming && current.session !== 'legacy')) throw fail('The page changed in another window. Your old drawing was not added to it.', 409);
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
        let directoryHandle;
        try {
          // Pin Linux cleanup to the directory whose owner was read. Another
          // process may release it and acquire a new lock at the same path.
          if (process.platform === 'linux') directoryHandle = await fs.open(lock, 'r');
          const ownerFile = directoryHandle ? `/proc/self/fd/${directoryHandle.fd}/owner` : path.join(lock, 'owner');
          try {
            const owner = Number(await fs.readFile(ownerFile, 'utf8'));
            // A crash between creating the owner file and writing its pid leaves it empty, and process.kill(0, 0)
            // reads as alive forever. After the same grace as an empty lock, the claimant whose rename wins removes it.
            if ((!Number.isSafeInteger(owner) || owner <= 0) && Date.now() - (await fs.stat(ownerFile)).mtimeMs > 30000) {
              const claim = `${ownerFile}.${process.pid}.${randomUUID()}`;
              await fs.rename(ownerFile, claim); await fs.unlink(claim); await fs.rmdir(lock);
            } else {
              try { process.kill(owner, 0); }
              catch (probe) { if (probe.code === 'ESRCH') { await fs.unlink(ownerFile); await fs.rmdir(lock); } }
            }
          } catch (probe) {
            if (probe.code === 'ENOENT') {
              const stat = directoryHandle ? await directoryHandle.stat() : await fs.stat(lock);
              if (Date.now() - stat.mtimeMs > 30000) {
                // Claim the empty generation before removing it. A handle to
                // an already removed directory cannot create this owner file.
                const claim = await fs.open(ownerFile, 'wx');
                try { await claim.writeFile(String(process.pid)); } finally { await claim.close(); }
                await fs.unlink(ownerFile); await fs.rmdir(lock);
              }
            }
          }
        } catch (probe) {
          if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(probe.code)) throw probe;
        } finally { await directoryHandle?.close(); }
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
  async function persist(scene) {
    const text = JSON.stringify(scene);
    await fs.mkdir(pages, { recursive: true });
    await atomic(pageFile(scene.page.name), text);
    await atomic(sceneFile, text);
    return { scene, revision: hash(text) };
  }
  async function save(incoming) {
    validate(incoming);
    return locked(async () => {
      const current = await read(); samePage(incoming.page, current.scene.page);
      const scene = merge(current.scene, incoming), text = JSON.stringify(scene);
      if (hash(text) !== current.revision) return persist(scene);
      return { scene, revision: hash(text) };
    });
  }
  // A closing editor may belong to the page another window just left.
  // Flush only its text to that exact archived page, without switching anyone.
  async function saveText(incoming) {
    validate(incoming);
    if (Object.keys(incoming).some(key => !['elements', 'page'].includes(key)) || incoming.elements.some(e => e.type !== 'text')
      || !record(incoming.page) || typeof incoming.page.session !== 'string' || !incoming.page.session) throw fail('Invalid text draft');
    pageName(incoming.page.name);
    return locked(async () => {
      const current = await read();
      if (incoming.page.session === current.scene.page.session) return persist(merge(current.scene, incoming));
      let scene;
      try { scene = validate(JSON.parse(await fs.readFile(pageFile(incoming.page.name), 'utf8'))); }
      catch { throw fail('The original text page could not be read. Your draft is still local.', 409); }
      samePage(incoming.page, scene.page);
      const merged = merge(scene, incoming), text = JSON.stringify(merged);
      await atomic(pageFile(scene.page.name), text);
      return { scene: merged, revision: hash(text) };
    });
  }
  async function listPages() {
    const current = await read(), listed = new Map();
    for (const file of (await names(pages)).filter(n => n.endsWith('.excalidraw'))) {
      const name = file.slice(0, -11);
      try { pageName(name); const stat = await fs.stat(pageFile(name)); if (stat.isFile()) listed.set(name, { name, modified: stat.mtimeMs }); }
      catch (e) { if (!e.loveSpot && e.code !== 'ENOENT') throw e; }
    }
    const modified = await fs.stat(sceneFile).then(s => s.mtimeMs).catch(e => { if (e.code === 'ENOENT') return Date.now(); throw e; });
    listed.set(current.scene.page.name, { name: current.scene.page.name, modified });
    return { current: current.scene.page, pages: [...listed.values()].sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name)) };
  }
  async function changePage(input) {
    if (!record(input) || !['new', 'switch', 'rename', 'delete'].includes(input.action) || Object.keys(input).some(k => !['action', 'name', 'page'].includes(k))
      || (input.action === 'delete' && (input.name === undefined || !input.page))) throw fail('Invalid page action');
    if (input.name !== undefined) pageName(input.name);
    return locked(async () => {
      const current = await read();
      if (input.page) samePage(input.page, current.scene.page);
      const listed = await names(pages);
      let name = input.name;
      if (input.action === 'delete') {
        const file = pageFile(name);
        try { await fs.access(file); }
        catch (e) { if (e.code === 'ENOENT') throw fail('That page could not be found.', 404); throw e; }
        if (name !== current.scene.page.name) { await trashFile(file); return current; }
        await fs.mkdir(pages, { recursive: true });
        await atomic(file, JSON.stringify(current.scene));
        let index = new Set([...listed, `${current.scene.page.name}.excalidraw`]).size + 1;
        let nextName;
        do { nextName = `Page ${index++}`; } while (listed.includes(`${nextName}.excalidraw`) || nextName === name);
        await trashFile(file);
        return persist({ type: 'excalidraw', version: 2, source: 'Love Spot', elements: [], files: {}, appState: {}, page: { name: nextName, session: randomUUID() } });
      }
      if (input.action === 'new' && name === undefined) {
        let index = new Set([...listed, `${current.scene.page.name}.excalidraw`]).size + 1;
        do { name = `Page ${index++}`; } while (listed.includes(`${name}.excalidraw`));
      }
      pageName(name);
      if (name === current.scene.page.name && input.action !== 'new') return current;
      if (input.action !== 'switch' && (name === current.scene.page.name || listed.includes(`${name}.excalidraw`))) throw fail('A page with that name already exists.', 409);
      let scene;
      if (input.action === 'switch') {
        try { scene = validate(JSON.parse(await fs.readFile(pageFile(name), 'utf8'))); }
        catch (e) { if (e.code === 'ENOENT') throw fail('That page could not be found.', 404); throw fail('That page could not be read. It has been left untouched.', 409); }
      } else scene = input.action === 'new' ? { type: 'excalidraw', version: 2, elements: [], files: {}, appState: {} } : current.scene;
      await fs.mkdir(pages, { recursive: true });
      await atomic(pageFile(current.scene.page.name), JSON.stringify(merge(current.scene, { elements: [] })));
      if (input.action === 'rename') await fs.rename(pageFile(current.scene.page.name), pageFile(name));
      return persist(merge({ ...scene, page: { name, session: input.action === 'rename' ? current.scene.page.session : randomUUID() } }, { elements: [] }));
    });
  }
  async function picture({ revision, png } = {}) {
    if (typeof png !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(png)) throw fail('Invalid PNG');
    const bytes = Buffer.from(png, 'base64');
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) throw fail('Invalid PNG');
    return locked(async () => {
      if (revision !== (await read()).revision) throw fail('The drawing changed. Export its current picture.', 409);
      await atomic(path.join(directory, 'view.png'), bytes);
      await atomic(path.join(directory, '.view-revision'), revision);
      return { saved: true };
    });
  }
  // The chat and its replies use the same lock as every board writer, including the standalone window.
  // `stale` names a saved chat Elpis no longer has: it is replaced, unless another window already did so.
  async function chat(create, stale) {
    return locked(async () => {
      const file = path.join(directory, '.love-spot-chat.json');
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (typeof saved.threadId !== 'string' || !saved.threadId) throw fail('Love Spot chat could not be read.', 409);
        if (saved.threadId !== stale) return saved.threadId;
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!create) return null;
      const id = await create(directory);
      await atomic(file, JSON.stringify({ threadId: id }));
      return id;
    });
  }
  async function boardPicture(revision) {
    return locked(async () => {
      const current = await read();
      if (revision !== current.revision || await fs.readFile(path.join(directory, '.view-revision'), 'utf8').catch(() => '') !== revision) throw fail('The drawing changed. Try sending again with its current picture.', 409);
      return (await fs.readFile(path.join(directory, 'view.png'))).toString('base64');
    });
  }
  async function reply(turnId, text, agentColor, page) {
    if (typeof text !== 'string' || !text.trim()) return;
    return locked(async () => {
      const { scene } = await read(), id = `love-reply-${turnId}`;
      if (page) samePage(page, scene.page);
      if (scene.elements.some(e => e.id === id)) return;
      const live = scene.elements.filter(e => !e.isDeleted);
      const anchor = live.filter(e => e.type === 'text' && !agentColor(e.strokeColor)).sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
      // Monospaced text and generous bounds keep restored font metrics inside the reserved area.
      const lines = text.trim().split('\n').flatMap(line => {
        const chars = Array.from(line), wrapped = [];
        // Wide glyphs and expanded tabs need more room than Latin letters when Excalidraw restores the font.
        const columns = char => char === '\t' ? 8 : char.codePointAt(0) > 127 ? 2 : 1;
        while (chars.length) {
          let at = 0, used = 0;
          while (at < chars.length && used + columns(chars[at]) <= 32) used += columns(chars[at++]);
          if (at === chars.length) { wrapped.push(chars.join('')); break; }
          const space = chars.slice(0, at + 1).lastIndexOf(' '); if (space >= 8) at = space;
          wrapped.push(chars.splice(0, at).join('')); if (chars[0] === ' ') chars.shift();
        }
        return wrapped.length ? wrapped : [''];
      });
      const width = 480, height = Math.max(1, lines.length) * 28;
      const bounds = e => {
        const angle = e.angle || 0, w = Math.abs(e.width * Math.cos(angle)) + Math.abs(e.height * Math.sin(angle)), h = Math.abs(e.width * Math.sin(angle)) + Math.abs(e.height * Math.cos(angle));
        return { x: e.x + e.width / 2 - w / 2, y: e.y + e.height / 2 - h / 2, width: w, height: h };
      };
      const a = anchor ? bounds(anchor) : { x: 0, y: -40, height: 0 };
      const x = a.x; let y = a.y + a.height + 40;
      for (;;) {
        const hits = live.map(bounds).filter(e => x < e.x + e.width + 24 && x + width + 24 > e.x && y < e.y + e.height + 24 && y + height + 24 > e.y);
        if (!hits.length) break;
        y = Math.max(...hits.map(e => e.y + e.height)) + 40;
      }
      const element = { id, type: 'text', x, y, width, height, angle: 0, strokeColor: '#1971c2', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1,
        strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 0,
        isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false, fontSize: 20, fontFamily: 3, text: lines.join('\n'),
        originalText: text.trim(), textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: false, lineHeight: 1.4 };
      await persist(merge(scene, { elements: [element] }));
    });
  }
  async function names(dir) { try { return await fs.readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
  async function importScreenshot(name, bytes, dataURL) {
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG)) return false;
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) return false;
    const id = screenshotId(name, bytes), scale = Math.min(1, 1200 / width);
    {
      const { scene } = await read();
      if (scene.elements.some(e => e.id === id)) return true;
      const live = scene.elements.filter(e => !e.isDeleted), now = Date.now();
      const element = { id, type: 'image', fileId: id, version: 1, versionNonce: 0, isDeleted: false,
        x: live.length ? Math.min(...live.map(e => e.x)) : 0, y: live.length ? Math.max(...live.map(e => e.y + e.height)) + 60 : 0,
        width: width * scale, height: height * scale, angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 1,
        strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, boundElements: null,
        updated: now, link: null, locked: false, status: 'saved', scale: [1, 1], crop: null };
      const file = { id, dataURL: dataURL ?? `data:image/png;base64,${bytes.toString('base64')}`, mimeType: 'image/png', created: now, lastRetrieved: now };
      validate({ elements: [], files: { [id]: file } });
      await persist(merge(scene, { elements: [element], files: { [id]: file } }));
    }
    return true;
  }
  async function chooseScreenshot(choice) {
    if (!record(choice)) throw fail('Invalid screenshot choice');
    const { id, action } = choice;
    if (typeof id !== 'string' || !['place', 'dismiss'].includes(action)) throw fail('Invalid screenshot choice');
    const shot = pending.get(id);
    if (!shot) throw fail('This screenshot has already left the tray.', 404);
    await locked(async () => {
      const choices = await screenshotChoices();
      if (choices.has(id)) { pending.delete(id); publishScreenshots(); throw fail('This screenshot has already left the tray.', 404); }
      if (action === 'place' && !await importScreenshot(shot.name, shot.bytes, choice.dataURL)) throw fail('Invalid screenshot');
      choices.add(id);
      await atomic(choicesFile, JSON.stringify([...choices]));
    });
    pending.delete(id);
    publishScreenshots();
    return action === 'place' ? read() : { dismissed: true };
  }
  async function tick() {
    if (running || closed) return;
    running = true;
    try {
      await fs.mkdir(inbox, { recursive: true });
      for (const name of (await names(inbox)).filter(n => n.endsWith('.json')).sort()) {
        const file = path.join(inbox, name);
        let data; try { data = validate(JSON.parse(await fs.readFile(file, 'utf8'))); } catch { continue; }
        await save({ ...data, page: data.page ?? (await read()).scene.page });
        // Commit before consuming. Two readers may both merge the same inbox file; the merge is idempotent.
        await trashFile(file);
      }
      await ensureSharing();
      let added = peerServer?.listening ? await receiveScreenshots() : false;
      const choices = await screenshotChoices();
      for (const id of pending.keys()) if (choices.has(id)) { pending.delete(id); added = true; }
      if (!seen) seen = new Set(await names(screenshots));
      for (const name of (await names(screenshots)).filter(n => /\.png$/i.test(n) && !seen.has(n))) {
        let bytes; try { bytes = await fs.readFile(path.join(screenshots, name)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        // Wait for a complete PNG (IEND), so a notification while GNOME is writing retries.
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG) || bytes.subarray(-8, -4).toString() !== 'IEND' || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) continue;
        let stat; try { stat = await fs.stat(path.join(screenshots, name)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        const id = screenshotId(name, bytes);
        if (!choices.has(id)) { pending.set(id, { id, name, bytes, modified: stat.mtimeMs }); added = true; }
        seen.add(name);
      }
      if (added) publishScreenshots();
      let stamp;
      try { const stat = await fs.stat(sceneFile); stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`; }
      catch (e) { if (e.code !== 'ENOENT') throw e; stamp = 'missing'; }
      if (stamp !== sceneStamp || previous === undefined) {
        const current = await read(); sceneStamp = stamp;
        if (current.revision !== previous) { previous = current.revision; for (const listen of listeners) listen({ type: 'scene', ...current }); }
      }
      if (peerError && lastError !== peerError) for (const listen of listeners) listen({ type: 'error', message: peerError });
      lastError = peerError; syncError = peerError;
    } catch (e) {
      syncError = e.loveSpot ? e.message : 'Love Spot could not sync the drawing.';
      if (lastError !== e.message) { lastError = e.message; for (const listen of listeners) listen({ type: 'error', message: syncError }); }
    } finally { running = false; }
  }
  async function start() {
    if (!starting) starting = (async () => {
      // Sample once at server startup, never again when a view subscribes.
      // A temporarily unavailable folder retries its baseline in tick().
      try { seen = new Set(await names(screenshots)); } catch {}
      await ensureSharing(); syncError = peerError;
      if (!closed) { timer = setInterval(() => void tick(), 150); timer.unref(); }
    })();
    return starting;
  }
  async function watch(listen) {
    await start();
    listeners.add(listen);
    try { listen({ type: 'scene', ...await read() }); } catch (e) { listen({ type: 'error', message: e.message }); }
    listen({ type: 'screenshots', screenshots: screenshotsList() });
    if (syncError) listen({ type: 'error', message: syncError });
    return () => { listeners.delete(listen); };
  }
  async function close() {
    closed = true; clearInterval(timer); timer = undefined; listeners.clear();
    if (starting) await starting.catch(() => {});
    while (running) await pause(10);
    for (const socket of sockets) socket.destroy();
    if (peerServer?.listening) await new Promise(resolve => peerServer.close(resolve));
    // Temporary peer cleanup must not prevent the app from quitting.
    await fs.unlink(peerSocket).catch(() => {});
    await fs.rmdir(peerDirectory).catch(() => {});
    pending.clear();
  }
  return { read, save, saveText, listPages, changePage, picture, boardPicture, chat, reply, start, watch, screenshotsList, chooseScreenshot, close };
}
module.exports = { createLoveSpot, newer, merge };
