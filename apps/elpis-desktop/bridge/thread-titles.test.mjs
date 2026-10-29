import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createThreadTitles, TITLE_INSTRUCTIONS, titlePrompt } from './thread-titles.mjs';

const CHAT = '00000000-0000-4000-8000-000000000001', SIDE = '00000000-0000-0000-0000-0000000000a1';
const userMessage = (text, threadId = CHAT) => ({ method: 'item/completed', params: { threadId, turnId: 't1', item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text, text_elements: [] }] } } });

/** A fake engine: a chat, its model catalog, and a background model that answers each side turn when `release` is called. */
function fixture({ name = null, models = ['gpt-5.6-luna', 'gpt-5.5'], answer = '{"title":"“Fix the login bug.”"}', thread = {} } = {}) {
  const bus = new EventEmitter(), starts = [], turns = [], renames = [];
  const chat = { id: CHAT, name, preview: 'Fix the login bug', model: 'gpt-5.5', modelProvider: 'openai', cwd: '/work/app', source: 'vscode', status: { type: 'active' }, ...thread };
  let release; const answered = new Promise(resolve => { release = resolve; });
  const client = {
    on: (event, listener) => bus.on(event, listener), off: (event, listener) => bus.off(event, listener),
    settings: async () => { throw Error('chat titles never use the background-model setting'); },
    models: async () => ({ data: models.map(model => ({ model })) }),
    readThreadMetadata: async id => { assert.equal(id, CHAT); return structuredClone(chat); },
    renameThread: async (id, { name: next }) => { renames.push([id, next]); chat.name = next; return { thread: chat }; },
    async sideRpc(method, params) {
      if (method === 'config/read') return { config: { mcp_servers: { rag: {}, shadcn: {} } } };
      if (method === 'thread/start') { starts.push(params); return { thread: { id: SIDE, ephemeral: true } }; }
      if (method === 'turn/start') {
        turns.push(params);
        void answered.then(() => {
          bus.emit('side', { method: 'item/completed', params: { threadId: SIDE, item: { type: 'agentMessage', text: answer, phase: 'final_answer' } } });
          bus.emit('side', { method: 'turn/completed', params: { threadId: SIDE, turn: { id: 'm', status: 'completed', items: [] } } });
        });
        return { turn: { id: 'm', status: 'inProgress', items: [] } };
      }
      return {};
    },
  };
  return { client, chat, starts, turns, renames, release };
}

test('the first message names the chat on gpt-5.6-luna at low effort, as the TUI does', async () => {
  const f = fixture(); f.release();
  const titles = createThreadTitles(f.client);
  await titles.event(userMessage('## Open tabs: auth.py\n## My request for Codex:\n  Fix the login bug in auth.py'));
  assert.deepEqual(f.renames, [[CHAT, 'Fix the login bug']], 'quotes and the full stop are trimmed');
  assert.equal(f.turns[0].input[0].text, `${TITLE_INSTRUCTIONS}\n\nUser prompt:\nFix the login bug in auth.py`);
  assert.equal(f.turns[0].effort, 'low');
  assert.deepEqual(f.turns[0].outputSchema, { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: 36 } }, required: ['title'], additionalProperties: false });
  const [start] = f.starts;
  assert.equal(start.model, 'gpt-5.6-luna'); assert.equal(start.modelProvider, 'openai'); assert.equal(start.ephemeral, true);
  assert.equal(start.permissions, ':read-only'); assert.equal(start.cwd, '/work/app');
  assert.equal(start.config['features.shell_tool'], false); assert.equal(start.config.web_search, 'disabled');
  assert.deepEqual(start.config.mcp_servers, { rag: { enabled: false }, shadcn: { enabled: false } }, 'no MCP server starts for a title');
  await titles.event(userMessage('And the logout bug'));
  assert.equal(f.starts.length, 1, 'a named chat is not titled again');
});

test('the title prompt is capped at 960 bytes without splitting a character, and long titles at 36 characters', async () => {
  const prompt = titlePrompt('سلام '.repeat(400));
  assert.ok(Buffer.byteLength(prompt) <= 960 && Buffer.byteLength(prompt) > 940);
  assert.ok(!prompt.includes('�'));
  const f = fixture({ answer: '{"title":"Refactor the entire authentication module for the new single sign-on flow"}' }); f.release();
  await createThreadTitles(f.client).event(userMessage('Refactor auth'));
  assert.equal(f.renames[0][1], 'Refactor the entire authentication m');
});

test('an existing name is kept: a named chat gets no title turn, and a name given meanwhile is not replaced', async () => {
  const named = fixture({ name: 'h' });
  await createThreadTitles(named.client).event(userMessage('Fix the login bug'));
  assert.equal(named.starts.length, 0);
  const f = fixture();
  const pending = createThreadTitles(f.client).event(userMessage('Fix the login bug'));
  await new Promise(resolve => setImmediate(resolve));
  f.chat.name = 'Named elsewhere';
  f.release(); await pending;
  assert.deepEqual(f.renames, []);
});

test('a manual rename cancels the pending title', async () => {
  const f = fixture(), titles = createThreadTitles(f.client);
  const pending = titles.event(userMessage('Fix the login bug'));
  await new Promise(resolve => setImmediate(resolve));
  f.chat.name = 'My name';
  titles.event({ method: 'thread/name/updated', params: { threadId: CHAT, threadName: 'My name' } });
  f.chat.name = null; // even if the engine reported no name afterwards, the cancelled title stays unused
  f.release(); await pending;
  assert.deepEqual(f.renames, []);
});

test('without gpt-5.6-luna in the catalog the chat\'s own model titles it, at its own effort', async () => {
  const f = fixture({ models: ['gpt-5.5'], thread: { model: 'claude/sonnet', modelProvider: 'claude' } }); f.release();
  await createThreadTitles(f.client).event(userMessage('Fix the login bug'));
  assert.equal(f.starts[0].model, 'claude/sonnet'); assert.equal(f.starts[0].modelProvider, 'claude');
  assert.equal(f.turns[0].effort, undefined);
  assert.deepEqual(f.renames, [[CHAT, 'Fix the login bug']]);
});

test('nothing else starts a title: replies, other events, agent runs, chats made by another chat, empty messages', async () => {
  for (const [thread, event] of [
    [{}, { method: 'item/completed', params: { threadId: CHAT, item: { type: 'agentMessage', text: 'Done.' } } }],
    [{}, { method: 'turn/completed', params: { threadId: CHAT, turn: { id: 't1', status: 'completed' } } }],
    [{}, userMessage('   ')],
    [{ source: 'exec' }, userMessage('Task ID: VOICE-RA-1')],
    [{ source: { subAgent: { thread_spawn: { parent_thread_id: 'p' } } } }, userMessage('Check the parser')],
    [{ parentThreadId: 'maker' }, userMessage('Check the parser')],
  ]) {
    const f = fixture({ thread }); f.release();
    await createThreadTitles(f.client).event(event);
    assert.equal(f.starts.length, 0, JSON.stringify([thread, event.method]));
  }
});
