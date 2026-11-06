import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, object, text } from './client.mts';

// Settings → Import chats (Masih, 23 Oct: "we should add the import chats options like cloudroom does"). Cloudroom imports a person's Claude Code and
// Codex chats as threads of its own, the agent keeping its memory and the originals untouched. Claude Code comes in through the engine's own session
// import. A Codex chat is its saved rollout: it is copied into Elpis's sessions folder under the same name (the original is never touched) and the
// engine registers the copy, so it lists, opens and forks like a chat Elpis made. A copy already there is a chat already imported.
// Codex 0.164 continues a long chat in later files, rollout-<time>-<id>_<segment>.jsonl, whose "paginated" history starts from the
// first file, rollout-<time>-<id>.jsonl. Such a chat is all its files: the engine registers the newest, and only once the earlier
// ones are in Elpis's folder (A267, 25 Oct: "Imported 0 chats from Codex. 2 skipped: …_01a17185-….jsonl: … (-32603)").
const DAYS = 30, AT_A_TIME = 50;
const LARGEST = 100 * 1024 * 1024; // one of his rollouts is 874 MB
const CHAT_SOURCES = new Set(['cli', 'vscode']); // not exec runs or sub-agents such as {"subagent":{"other":"guardian"}}
const SOURCES = [['claude-code', 'Claude Code'], ['codex', 'Codex']] as const;
type Rollout = { file: string; relative: string; modified: number; size: number };
type Chat = { files: Rollout[]; head: Rollout; modified: number };
type ImportClient = { externalSessions(): Promise<unknown[]>; importExternalSessions?(chats: unknown[]): Promise<{ imported: number; skipped: unknown[] }>; registerRollout?(file: string): Promise<unknown> };
const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl$/;
const exists = (file: string) => fs.access(file).then(() => true, () => false);

/** The rollout's first line, its session_meta; read in pieces so a large rollout is never loaded whole. */
async function sessionMeta(file: string) {
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

async function codexRollouts(sessions: string) {
  const found: Rollout[] = [];
  async function walk(directory: string, depth: number) {
    let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return; throw cause; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 3) await walk(file, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
        const stat = await fs.stat(file);
        found.push({ file, relative: path.relative(sessions, file), modified: stat.mtimeMs, size: stat.size });
      }
    }
  }
  await walk(sessions, 0);
  return found;
}

/** Rollouts as chats, newest first: each chat's files in the order they were started, and its newest file, which the engine registers. */
function chatsOf(rollouts: Rollout[]) {
  const byChat = new Map<string, Rollout[]>();
  for (const rollout of rollouts) {
    const key = ROLLOUT.exec(path.basename(rollout.file))?.[1] ?? rollout.file; // a name of another form is a chat of its own
    byChat.set(key, [...(byChat.get(key) ?? []), rollout]);
  }
  return [...byChat.values()].map(files => {
    files.sort((a, b) => path.basename(a.file).localeCompare(path.basename(b.file)));
    return { files, head: files.at(-1)!, modified: Math.max(...files.map(file => file.modified)) };
  }).sort((a, b) => b.modified - a.modified);
}

export function createImportChats({ client, codexHome = path.join(os.homedir(), '.codex'), elpisHome = process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'), now = Date.now, largest = LARGEST }: { client: ImportClient; codexHome?: string; elpisHome?: string; now?: () => number; largest?: number }) {
  let running = false;
  const from = path.join(codexHome, 'sessions'), into = path.join(elpisHome, 'sessions');
  async function codexChats() {
    const chats = [], since = now() - DAYS * 86_400_000;
    for (const chat of chatsOf(await codexRollouts(from))) {
      if (chat.modified < since || chat.files.some(file => file.size > largest)) continue;
      if (await exists(path.join(into, chat.head.relative))) continue;
      const meta = await sessionMeta(chat.head.file);
      if (typeof meta?.id === 'string' && CHAT_SOURCES.has(meta.source)) chats.push(chat);
    }
    return chats;
  }
  async function importCodex(chat: Chat) {
    const copied = [];
    try {
      for (const { file, relative } of chat.files) {
        const target = path.join(into, relative);
        if (await exists(target)) continue; // an earlier file of this chat that came in before stays as it is
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
        await fs.copyFile(file, target, fs.constants.COPYFILE_EXCL);
        copied.push(target);
      }
      await client.registerRollout!(path.join(into, chat.head.relative));
    } catch (cause) { // a chat the engine refused is not left behind as "imported"
      for (const target of copied) await fs.unlink(target).catch(() => {});
      throw cause;
    }
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
    async run(body: unknown) {
      const request = object(body, ['source']) as { source?: unknown }; text(request.source, 'source', 40);
      if (request.source !== 'claude-code' && request.source !== 'codex') throw new BridgeError('Choose Claude Code or Codex.', 400);
      if (running) throw new BridgeError('An import is already running.', 409);
      running = true;
      try {
        const chats = (await listers[request.source]()).slice(0, AT_A_TIME);
        if (request.source === 'claude-code') return await client.importExternalSessions!(chats);
        const skipped = []; let imported = 0;
        for (const chat of chats as Chat[]) {
          try { await importCodex(chat as Chat); imported++; }
          catch (cause) { skipped.push(`${path.basename(chat.head.file)}: ${cause instanceof Error ? cause.message : String(cause)}`); }
        }
        return { imported, skipped };
      } finally { running = false; }
    },
  };
}
