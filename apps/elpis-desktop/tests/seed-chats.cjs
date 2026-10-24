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
/** A long chat shaped like a real Elpis rollout (paginated history: task_started, turn_context, the user's message,
 * `tools` command steps, the final answer, task_complete per turn). Questions read "Question 1".."Question N".
 * → the chat's id. */
function seedLongChat(home, { name = 'Long chat', turns = 40, tools = 3, minutesAgo = 5, now = Date.now() } = {}) {
  const start = now - minutesAgo * 60000, id = uuid7(start - turns * 60000), cwd = path.join(path.resolve(home), 'work');
  const first = new Date(start - turns * 60000).toISOString(), stamp = first.slice(0, 19).replace(/:/g, '-');
  const dir = path.join(home, 'sessions', first.slice(0, 4), first.slice(5, 7), first.slice(8, 10)), rows = [];
  const row = (ms, type, payload) => rows.push({ timestamp: new Date(ms).toISOString(), ordinal: rows.length, type, payload });
  row(start - turns * 60000, 'session_meta', { session_id: id, id, timestamp: first, cwd, originator: 'elpis-desktop', cli_version: '0.162.0', source: 'vscode', thread_source: 'user', model_provider: 'openai', history_mode: 'paginated' });
  for (let n = 1; n <= turns; n++) {
    const ms = start - (turns - n + 1) * 60000, turn = uuid7(ms), question = `Question ${n}`, answer = `Answer ${n}`;
    row(ms, 'event_msg', { type: 'task_started', turn_id: turn, root_turn_id: turn, started_at: Math.floor(ms / 1000), model_context_window: 400000, collaboration_mode_kind: 'default' });
    row(ms, 'turn_context', { turn_id: turn, root_turn_id: turn, cwd, approval_policy: 'never', sandbox_policy: { type: 'read-only' }, model: 'gpt-test', summary: 'auto' });
    row(ms, 'response_item', { type: 'message', id: `msg_u${n}`, role: 'user', content: [{ type: 'input_text', text: question }] });
    row(ms, 'event_msg', { type: 'item_completed', thread_id: id, turn_id: turn, item: { type: 'UserMessage', id: `user-${n}`, content: [{ type: 'text', text: question, text_elements: [] }] }, started_at_ms: ms, completed_at_ms: ms });
    for (let k = 0; k < tools; k++) row(ms + 1000 + k, 'event_msg', { type: 'item_completed', thread_id: id, turn_id: turn, item: { type: 'CommandExecution', id: `exec-${n}-${k}`, command: ['/bin/bash', '-lc', `echo step ${k}`], cwd: `file://${cwd}`, parsed_cmd: [{ type: 'unknown', cmd: `echo step ${k}` }], source: 'agent', status: 'completed', aggregated_output: `step ${k}\n`, exit_code: 0, duration: { secs: 0, nanos: 1000000 } }, started_at_ms: ms + 1000 + k, completed_at_ms: ms + 1001 + k });
    row(ms + 2000, 'response_item', { type: 'message', id: `msg_a${n}`, role: 'assistant', content: [{ type: 'output_text', text: answer }] });
    row(ms + 2000, 'event_msg', { type: 'item_completed', thread_id: id, turn_id: turn, item: { type: 'AgentMessage', id: `agent-${n}`, content: [{ type: 'Text', text: answer }], phase: 'final_answer' }, started_at_ms: ms + 2000, completed_at_ms: ms + 2000 });
    row(ms + 3000, 'event_msg', { type: 'task_complete', turn_id: turn, root_turn_id: turn, last_agent_message: answer, started_at: Math.floor(ms / 1000), completed_at: Math.floor(ms / 1000) + 3, duration_ms: 3000 });
  }
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  fs.writeFileSync(file, rows.map(item => JSON.stringify(item)).join('\n') + '\n'); fs.utimesSync(file, start / 1000, start / 1000);
  fs.appendFileSync(path.join(home, 'session_index.jsonl'), JSON.stringify({ id, thread_name: name, updated_at: new Date(start).toISOString() }) + '\n');
  return id;
}
module.exports = { seedChats, seedLongChat, uuid7 };
