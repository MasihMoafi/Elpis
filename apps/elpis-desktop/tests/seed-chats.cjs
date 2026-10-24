// Controlled engine chats for real-app checks: rollouts and names written into a seed folder that app.sh copies into a
// throwaway ELPIS_HOME, so every case is known. Names go where the engine keeps them (session_index.jsonl).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** A UUIDv7 whose time part is `ms`, so the engine orders chats by it. */
function uuid7(ms) {
  const b = crypto.randomBytes(16);
  b.writeUIntBE(ms, 0, 6); b[6] = 0x70 | (b[6] & 0x0f); b[8] = 0x80 | (b[8] & 0x3f);
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** chats: [{ key, name?, text, minutesAgo, archived?, parentKey?, subAgentOf?, cwd? }] → { key: id } */
function seedChats(home, chats, now = Date.now()) {
  const ids = {}, names = [], links = {};
  for (const chat of chats) ids[chat.key] = uuid7(now - chat.minutesAgo * 60000);
  for (const chat of chats) {
    const ms = now - chat.minutesAgo * 60000, at = new Date(ms).toISOString(), id = ids[chat.key];
    const stamp = at.slice(0, 19).replace(/:/g, '-');
    const dir = chat.archived ? path.join(home, 'archived_sessions') : path.join(home, 'sessions', at.slice(0, 4), at.slice(5, 7), at.slice(8, 10));
    fs.mkdirSync(dir, { recursive: true });
    const source = chat.subAgentOf ? { subagent: { thread_spawn: { parent_thread_id: ids[chat.subAgentOf], depth: 1, agent_nickname: chat.name } } } : 'vscode';
    const cwd = chat.cwd || path.join(path.resolve(home), 'work');
    const rows = [
      { timestamp: at, type: 'session_meta', payload: { session_id: id, id, timestamp: at, cwd, originator: 'elpis-desktop', cli_version: '0.162.0', source, thread_source: chat.subAgentOf ? 'subagent' : 'user', model_provider: 'openai' } },
      { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: chat.text }] } },
      { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: chat.text, images: [], local_images: [], text_elements: [] } },
      { timestamp: at, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Noted: ${chat.text}` }] } },
      { timestamp: at, type: 'event_msg', payload: { type: 'agent_message', message: `Noted: ${chat.text}` } },
    ];
    fs.writeFileSync(path.join(dir, `rollout-${stamp}-${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    fs.utimesSync(path.join(dir, `rollout-${stamp}-${id}.jsonl`), ms / 1000, ms / 1000);
    if (chat.name) names.push({ id, thread_name: chat.name, updated_at: at });
    if (chat.parentKey) links[id] = ids[chat.parentKey];
  }
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  fs.appendFileSync(path.join(home, 'session_index.jsonl'), names.map(row => JSON.stringify(row)).join('\n') + '\n');
  if (Object.keys(links).length) fs.writeFileSync(path.join(home, 'desktop-spawn-links.json'), JSON.stringify(links));
  return ids;
}
module.exports = { seedChats, uuid7 };
