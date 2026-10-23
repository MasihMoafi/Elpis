import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError, object, text } from './client.mjs';

// Settings → Import chats (Masih, 23 Oct: "we should add the import chats options like cloudroom does"). Cloudroom imports a person's Claude Code
// and Codex chats as threads of its own, the agent keeping its memory and the originals untouched. Here: Claude Code through the engine's own
// session import (the last 30 days, at most 50 a time, never one already imported), Codex by forking each saved rollout into a chat of Elpis.
const DAYS = 30, AT_A_TIME = 50;
const SOURCES = [['claude-code', 'Claude Code'], ['codex', 'Codex']];

async function rollouts(root, since) {
  const found = [];
  async function walk(directory, depth) {
    let entries; try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (cause) { if (cause.code === 'ENOENT') return; throw cause; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory() && depth < 4) await walk(file, depth + 1);
      else if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) { const stat = await fs.stat(file); if (stat.mtimeMs >= since) found.push({ file, modified: stat.mtimeMs }); }
    }
  }
  await walk(root, 0);
  return found.sort((a, b) => b.modified - a.modified);
}

export function createImportChats({ client, codexHome = path.join(os.homedir(), '.codex'), ledgerFile = path.join(process.env.ELPIS_HOME || path.join(os.homedir(), '.elpis-next'), 'desktop-chat-imports.json'), now = Date.now }) {
  let running = false;
  const readLedger = async () => { try { return JSON.parse(await fs.readFile(ledgerFile, 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return {}; throw new BridgeError('Could not read the list of imported chats.', 500); } };
  async function writeLedger(ledger) {
    const temporary = `${ledgerFile}.${randomUUID()}.pending`;
    await fs.mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(temporary, JSON.stringify(ledger), { mode: 0o600 }); await fs.rename(temporary, ledgerFile);
  }
  const codexChats = async () => { const done = await readLedger(); return (await rollouts(path.join(codexHome, 'sessions'), now() - DAYS * 86_400_000)).filter(chat => !done[chat.file]); };
  const claudeChats = () => client.externalSessions();
  const listers = { 'claude-code': claudeChats, codex: codexChats };
  return {
    /** What could be imported now, by app: only the apps that have chats are listed. */
    async list() {
      const sources = [];
      for (const [id, name] of SOURCES) { const chats = (await listers[id]()).length; if (chats) sources.push({ id, name, chats }); }
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
        const done = await readLedger(), skipped = []; let imported = 0;
        for (const chat of chats) {
          try { const thread = await client.importRollout(chat.file); done[chat.file] = thread?.id ?? true; imported++; await writeLedger(done); }
          catch (cause) { skipped.push(cause instanceof Error ? cause.message : String(cause)); }
        }
        return { imported, skipped };
      } finally { running = false; }
    },
  };
}
