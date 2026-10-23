import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, object, text } from './client.mjs';

// Settings → Import chats (Masih, 23 Oct: "we should add the import chats options like cloudroom does"). Cloudroom imports a person's Claude Code and
// Codex chats as threads of its own, the agent keeping its memory and the originals untouched. Claude Code comes in through the engine's own session
// import. A Codex chat is its saved rollout: it is copied into Elpis's sessions folder under the same name (the original is never touched) and the
// engine registers the copy, so it lists, opens and forks like a chat Elpis made. A copy already there is a chat already imported.
const DAYS = 30, AT_A_TIME = 50;
const LARGEST = 100 * 1024 * 1024; // one of his rollouts is 874 MB
const CHAT_SOURCES = new Set(['cli', 'vscode']); // not exec runs or sub-agents such as {"subagent":{"other":"guardian"}}
const SOURCES = [['claude-code', 'Claude Code'], ['codex', 'Codex']];

/** The rollout's first line, its session_meta; read in pieces so a large rollout is never loaded whole. */
async function sessionMeta(file) {
  const handle = await fs.open(file, 'r');
  try {
    const chunks = [];
    for (let position = 0, total = 0; total < 4 * 1024 * 1024;) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      const piece = buffer.subarray(0, bytesRead), end = piece.indexOf(10);
      chunks.push(end < 0 ? piece : piece.subarray(0, end));
      if (end >= 0) break;
      position += bytesRead; total += bytesRead;
    }
    const line = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return line?.type === 'session_meta' ? line.payload : null;
  } catch { return null; } finally { await handle.close(); }
}

async function codexRollouts(sessions, since, largest) {
  const found = [];
  async function walk(directory, depth) {
    let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(file, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const stat = await fs.stat(file);
        if (stat.mtimeMs >= since && stat.size <= largest) found.push({ file, relative: path.relative(sessions, file), modified: stat.mtimeMs });
      }
    }
  }
  await walk(sessions, 0);
  return found.sort((a, b) => b.modified - a.modified);
}

export function createImportChats({ client, codexHome = path.join(os.homedir(), '.codex'), elpisHome = process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'), now = Date.now, largest = LARGEST }) {
  let running = false;
  const from = path.join(codexHome, 'sessions'), into = path.join(elpisHome, 'sessions');
  async function codexChats() {
    const chats = [];
    for (const chat of await codexRollouts(from, now() - DAYS * 86_400_000, largest)) {
      if (await fs.access(path.join(into, chat.relative)).then(() => true, () => false)) continue;
      const meta = await sessionMeta(chat.file);
      if (typeof meta?.id === 'string' && CHAT_SOURCES.has(meta.source)) chats.push(chat);
    }
    return chats;
  }
  async function importCodex(chat) {
    const target = path.join(into, chat.relative);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.copyFile(chat.file, target, fs.constants.COPYFILE_EXCL);
    try { await client.registerRollout(target); }
    catch (cause) { await fs.unlink(target).catch(() => {}); throw cause; } // a copy the engine refused is not left behind as "imported"
  }
  const listers = { 'claude-code': () => client.externalSessions(), codex: codexChats };
  return {
    /** Both apps, each with how many chats could be imported now (none is a count of 0: the option is always there, as in Cloudroom). */
    async list() {
      const sources = [];
      for (const [id, name] of SOURCES) sources.push({ id, name, chats: (await listers[id]()).length });
      return { days: DAYS, atATime: AT_A_TIME, sources };
    },
    /** Imports up to 50 of one app's chats; the rest wait for the next press. */
    async run(body) {
      object(body, ['source']); text(body.source, 'source', 40);
      if (!listers[body.source]) throw new BridgeError('Choose Claude Code or Codex.', 400);
      if (running) throw new BridgeError('An import is already running.', 409);
      running = true;
      try {
        const chats = (await listers[body.source]()).slice(0, AT_A_TIME);
        if (body.source === 'claude-code') return await client.importExternalSessions(chats);
        const skipped = []; let imported = 0;
        for (const chat of chats) {
          try { await importCodex(chat); imported++; }
          catch (cause) { skipped.push(`${path.basename(chat.file)}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
        return { imported, skipped };
      } finally { running = false; }
    },
  };
}
