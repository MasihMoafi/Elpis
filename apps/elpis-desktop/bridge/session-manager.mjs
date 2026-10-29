import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './validate.mjs';
import { isAgentRun, agentParentId } from '../lib/agent-runs.mjs';
import { archiveReason, chatName, mayArchive, needsName, placeholder } from '../lib/session-rules.mjs';
import { askBackground } from './side-turn.mjs';

const TITLE_SCHEMA = { type: 'object', additionalProperties: false, required: ['title'], properties: { title: { type: 'string' } } };
const TITLE_BUDGET = 4000; // characters of the chat shown to the model, about 1,000 tokens
const TITLE_TIMEOUT_MS = 30000;

/** The first request worth a title and as many of the latest turns as fit the budget. */
function titlePrompt(prompts) {
  const turn = ({ text, reply }) => `Masih: ${text}${reply ? `\nElpis: ${reply}` : ''}`;
  const first = prompts.find(prompt => chatName([prompt])), recent = [];
  let size = turn(first).length;
  for (const prompt of prompts.slice(prompts.indexOf(first) + 1).reverse()) {
    if (size + turn(prompt).length > TITLE_BUDGET) break;
    recent.unshift(turn(prompt)); size += turn(prompt).length;
  }
  return ['Write the title of this chat for the list of chats: 2 to 6 words, at most 60 characters, naming what the chat is about. '
    + 'Use the language the chat is written in. No quotation marks and no full stop. Answer only as JSON: {"title": "..."}.',
  `First request:\n${turn(first)}`, ...(recent.length ? [`Latest turns:\n${recent.join('\n\n')}`] : [])].join('\n\n');
}
/** A short title from the background model, read-only and with no chat of its own; throws when none is usable. */
async function modelTitle(client, prompts) {
  const answer = await askBackground(client, { prompt: titlePrompt(prompts), schema: TITLE_SCHEMA, permissions: ':read-only', timeoutMs: TITLE_TIMEOUT_MS,
    failed: 'Elpis could not title the chat', late: 'Elpis did not title the chat in time' });
  const title = JSON.parse(answer.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''))?.title;
  const clean = typeof title === 'string' ? title.replace(/\s+/g, ' ').replace(/^["'“”«]+|["'“”».]+$/g, '').trim() : '';
  if (!clean || Array.from(clean).length > 80 || needsName({ name: clean })) throw Error('The model gave no usable title');
  return clean;
}

/** The Session Manager (R43, R47): always on, with no switch, chat or view. It names chats whose title says nothing (by
 * the background model, from the chat's first request and latest turns) and
 * archives the empty, abandoned and finished ones. It never touches a running chat; never archives one waiting on Masih,
 * one he named, one he protects (pinned, open, unread, in a project) or one he brought back, until it has a new turn.
 * Each archive carries its reason into Settings > Archived, where Unarchive restores it. */
export async function createSessionManager({ client, file, now = Date.now }) {
  // named: the names it gave ({ name, from }); restored: the turn a chat was on when Masih unarchived it.
  let state = { named: {}, restored: {} }, queue = Promise.resolve(), protectedIds = new Set();
  const turns = new Map(), prompted = new Map();
  if (file) try {
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!['named', 'restored'].every(key => saved?.[key] && typeof saved[key] === 'object' && !Array.isArray(saved[key]))) throw Error('Invalid Session Manager state');
    state = saved;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const save = async () => {
    if (!file) return;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.pending`;
    await fs.writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await fs.rename(temporary, file);
  };
  const serial = work => { const next = queue.catch(() => {}).then(work); queue = next; return next; };
  const changed = thread => JSON.stringify([thread.updatedAt, thread.status]);
  /** A name he chose, including the "h" it replaced; not a placeholder and not one it gave. */
  const named = thread => {
    const ours = state.named[thread.id];
    return ours && thread.name === ours.name ? ours.from !== null : !!thread.name?.trim() && !placeholder(thread.name);
  };
  async function list() {
    const threads = new Map(), cursors = new Set(); let cursor;
    do {
      const page = await client.listThreads({ limit: 100, includeAgentRuns: true, ...(cursor ? { cursor } : {}) });
      for (const thread of page.data) threads.set(thread.id, thread);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new BridgeError('Session list repeated a page', 502);
      cursors.add(cursor);
    } while (cursor);
    return [...threads.values()];
  }
  async function latest(thread) {
    const key = changed(thread);
    if (turns.get(thread.id)?.key !== key) turns.set(thread.id, { key, value: await client.readSessionTurn(thread.id) });
    return turns.get(thread.id).value;
  }
  /** Names the chat with the model's title. When the model fails, its first request worth a title stands in, and the
   * model is asked again on the next run. A chat with nothing worth a title is read again only once it changes. */
  async function rename(thread) {
    if (prompted.get(thread.id) === changed(thread)) return false;
    const prompts = (await client.readPrompts(thread.id)).data, fallback = chatName(prompts);
    let guessed = false;
    const name = fallback && await modelTitle(client, prompts).catch(() => { guessed = true; return fallback; });
    const ours = state.named[thread.id], fresh = !!name && name !== thread.name;
    if (fresh) await client.renameThread(thread.id, { name });
    if (!guessed) prompted.set(thread.id, changed(thread));
    if (!name) return false;
    state.named[thread.id] = { name, from: ours && thread.name === ours.name ? ours.from : thread.name?.trim() || null, ...(guessed ? { guessed: true } : {}) };
    thread.name = name; await save();
    return fresh;
  }
  const guessedName = thread => !!state.named[thread.id]?.guessed && thread.name === state.named[thread.id].name;
  /** The reason to archive this chat now, or null; checked again under the archive lock. */
  const reason = (thread, turn) => protectedIds.has(thread.id) || named(thread) || state.restored[thread.id] === (turn?.id ?? '') ? null
    : archiveReason(thread, turn, client.pendingApprovals, now());
  return {
    run(input) {
      if (!Array.isArray(input?.protectedIds) || input.protectedIds.length > 10000 || input.protectedIds.some(id => typeof id !== 'string')) throw new BridgeError('Provide protected chat IDs');
      // Set before queueing, so a run already archiving sees a chat pinned or opened meanwhile.
      protectedIds = new Set(input.protectedIds);
      return serial(async () => {
        const threads = await list(), renamed = [], archived = [], failures = [];
        const parents = new Set(threads.map(agentParentId).filter(Boolean));
        for (const thread of threads) {
          if (isAgentRun(thread) || agentParentId(thread) || thread.status?.type === 'active') continue;
          try { if ((needsName(thread) || guessedName(thread)) && await rename(thread)) renamed.push(thread.id); } catch { failures.push(thread.id); }
          // Archiving a parent archives its family; that stays the owner's choice. A cheap check spares reading most chats.
          if (parents.has(thread.id) || protectedIds.has(thread.id) || named(thread) || !mayArchive(thread, now())) continue;
          try {
            const { turn } = await latest(thread), turnId = turn?.id ?? null;
            if (!reason(thread, turn)) continue;
            await client.archiveThread(thread.id, {}, current => {
              const why = (current.turn?.id ?? null) === turnId && reason(current.thread, current.turn);
              if (!why) throw new BridgeError('Chat changed while archiving', 409);
              return why;
            });
            archived.push(thread.id); turns.delete(thread.id);
          } catch { failures.push(thread.id); }
        }
        return { renamed, archived, failures };
      });
    },
    /** Masih brought this chat back (Settings > Archived, or undoing a deletion): it stays until it has a new turn. */
    unarchived: id => serial(async () => {
      const { turn } = await client.readSessionTurn(id);
      state.restored[id] = turn?.id ?? ''; turns.delete(id); await save();
    }),
  };
}
