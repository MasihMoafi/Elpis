import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// One atomic file per chat: separate bridge connections never overwrite other chats' choices.
// Absence means inherit. Engine turn contexts alone cannot establish that the person chose a mode.
export class PermissionChoices {
  constructor(home) { this.directory = path.join(home, 'permission-choices'); }
  file(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error('Invalid chat permission record');
    return path.join(this.directory, `${id}.json`);
  }
  async read(id) {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async write(id, settings) {
    const file = this.file(id);
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const pending = `${file}.${randomUUID()}`;
    await fs.writeFile(pending, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
    await fs.rename(pending, file);
  }
}
