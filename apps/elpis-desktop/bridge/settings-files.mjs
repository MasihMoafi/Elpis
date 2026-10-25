import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeError, object } from './client.mjs';

const names = { instructions: 'AGENTS.md', memory: 'memories/MEMORY.md' };
const version = (file, content) => createHash('sha256').update(file).update('\0').update(content).digest('hex');

/** Only the engine's two global text files; never a renderer-supplied path. */
export function createSettingsFiles(home, io = fs) {
  let queue = Promise.resolve();
  const fileFor = kind => {
    if (!Object.hasOwn(names, kind)) throw new BridgeError('Unknown personalization file');
    return path.join(home, names[kind]);
  };
  async function checkDirectory(file) {
    const directory = path.dirname(file);
    if (directory !== home) {
      try { if (!(await io.lstat(directory)).isDirectory()) throw new BridgeError('The memories folder must be a local directory.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  async function read(kind) {
    const configured = fileFor(kind);
    await checkDirectory(configured);
    let file;
    try { file = await io.realpath(configured); }
    catch (error) {
      if (error.code === 'ELOOP') throw new BridgeError('The personalization file link cannot be resolved. Repair the link before editing.', 409);
      if (error.code !== 'ENOENT') throw error;
      const entry = await io.lstat(configured).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (entry?.isSymbolicLink()) throw new BridgeError('The linked personalization file does not exist. Repair the link before editing.', 409);
      file = configured;
    }
    let handle;
    try {
      handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) throw new BridgeError('This personalization file must be a regular file.');
      const content = await handle.readFile('utf8');
      return { path: file, content, version: version(file, content) };
    } catch (error) {
      if (error.code === 'ENOENT') return { path: file, content: '', version: 'missing' };
      if (error.code === 'ELOOP') throw new BridgeError('The personalization file link changed. Reload before editing.', 409);
      throw error;
    } finally { await handle?.close(); }
  }
  function save(kind, input) {
    const run = async () => {
      const data = object(input, ['version', 'content']);
      if (typeof data.content !== 'string' || typeof data.version !== 'string') throw new BridgeError('File content and version are required.');
      const before = await read(kind);
      if (data.version !== before.version) throw new BridgeError('File changed elsewhere. Reload before saving. Your draft is preserved.', 409);
      const file = before.path, directory = path.dirname(file), temporary = `${file}.${randomUUID()}.pending`;
      let handle;
      try {
        await io.mkdir(directory, { recursive: true, mode: 0o700 });
        await checkDirectory(file);
        handle = await io.open(temporary, 'wx', 0o600);
        await handle.writeFile(data.content, 'utf8'); await handle.sync(); await handle.close(); handle = undefined;
        if ((await read(kind)).version !== before.version) throw new BridgeError('File changed elsewhere. Reload before saving. Your draft is preserved.', 409);
        await io.rename(temporary, file);
        handle = await io.open(directory, 'r'); await handle.sync();
        return { path: file, content: data.content, version: version(file, data.content) };
      } finally {
        await handle?.close();
        await io.unlink(temporary).catch(() => {});
      }
    };
    const next = queue.then(run); queue = next.catch(() => {}); return next;
  }
  return { read, save };
}
