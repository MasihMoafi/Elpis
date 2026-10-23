import { BridgeError, object, text } from './client.mjs';

// Settings → Import chats (Masih, 23 Oct: "we should add the import chats options like cloudroom does"). Cloudroom imports a person's Claude Code and
// Codex chats as threads of its own, the agent keeping its memory and the originals untouched. Here: Claude Code, through the engine's own session
// import (the last 30 days, at most 50 a time, never one already imported; checked on a real chat 23 Oct). Codex chats cannot come in yet: the engine
// can fork only a chat it has registered, and a rollout copied into its sessions folder is read but never registered or listed (checked 23 Oct).
const DAYS = 30, AT_A_TIME = 50;

export function createImportChats({ client }) {
  let running = false;
  return {
    /** What could be imported now, by app: only an app that has chats is listed. */
    async list() {
      const chats = (await client.externalSessions()).length;
      return { days: DAYS, atATime: AT_A_TIME, sources: chats ? [{ id: 'claude-code', name: 'Claude Code', chats }] : [] };
    },
    /** Imports up to 50 Claude Code chats; the rest wait for the next press. */
    async run(body) {
      object(body, ['source']); text(body.source, 'source', 40);
      if (body.source !== 'claude-code') throw new BridgeError('Only Claude Code chats can be imported so far.', 400);
      if (running) throw new BridgeError('An import is already running.', 409);
      running = true;
      try { return await client.importExternalSessions((await client.externalSessions()).slice(0, AT_A_TIME)); }
      finally { running = false; }
    },
  };
}
