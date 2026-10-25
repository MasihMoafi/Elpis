import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { BridgeError, DesktopClient } from './client.mjs';
import { planCanvas } from './canvas-plan.mjs';
import { startDesktopServer } from './server.mjs';

const THREAD = '00000000-0000-0000-0000-0000000000a1';
const FOLDERS = ['api', 'docs', 'web', 'web/components'];
const PLAN = { name: 'Notes app', agents: [
  { key: 'api', title: 'Build the notes API', prompt: 'Add the notes endpoints in api/ with their tests.', folders: ['api'], doneWhen: ['the API tests pass'], waitsFor: [] },
  { key: 'web', title: 'Build the notes screen', prompt: 'Add the notes screen in web/ with its tests.', folders: ['web'], doneWhen: ['the screen lists notes'], waitsFor: ['api'] },
] };
const BODY = { goal: 'Build a small notes app', cwd: '/work/project', folders: FOLDERS, agents: [], maxAgents: 4 };
const clone = value => structuredClone(value);

/** A client with a fake engine: the settings, `sideRpc` and the 'side' notifications the planner uses. */
function fakeClient({ background = { model: 'fast-model', provider: 'local' }, main = { model: 'big-model', provider: 'openai' }, answer = PLAN, status = 'completed',
  error, ephemeral = true, silent = false, extra = [] } = {}) {
  const bus = new EventEmitter(), sent = [];
  const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
  const side = (method, params) => bus.emit('side', { method, params });
  return { sent, bus, connected: true, pendingApprovals: [], close() {}, ragEnvironment: async () => ({}),
    on: (name, listener) => bus.on(name, listener), off: (name, listener) => bus.off(name, listener),
    settings: async () => ({ main, background }),
    async sideRpc(method, params) {
      sent.push({ method, params });
      if (method === 'thread/start') return { thread: { id: THREAD, ephemeral }, model: 'm', modelProvider: 'p' };
      if (method === 'turn/start') {
        // The engine may answer before the turn/start response is read.
        if (!silent) queueMicrotask(() => {
          for (const item of extra) side('item/completed', { threadId: THREAD, turnId: 't1', item });
          side('item/completed', { threadId: THREAD, turnId: 't1', item: { type: 'agentMessage', id: 'final', text, phase: 'final_answer' } });
          side('turn/completed', { threadId: THREAD, turn: { id: 't1', status, items: [], ...(error ? { error: { message: error } } : {}) } });
        });
        return { turn: { id: 't1', status: 'inProgress', items: [] } };
      }
      return {};
    },
    methods: () => sent.map(row => row.method) };
}
const plan = async (overrides = {}, options = {}, body = BODY) => {
  const client = fakeClient(overrides);
  return { client, result: await planCanvas(client, body, options) };
};
const refused = (promise, status, pattern) => assert.rejects(promise, error => error instanceof BridgeError && error.status === status && pattern.test(error.message), String(pattern));

test('plans in one ephemeral, read-only, no-approval conversation on the background model, with a schema for the answer', async () => {
  const { client } = await plan();
  const start = client.sent.find(row => row.method === 'thread/start').params;
  assert.deepEqual(start, { ephemeral: true, model: 'fast-model', modelProvider: 'local', cwd: '/work/project', approvalPolicy: 'never', permissions: ':danger-full-access' });
  const turns = client.sent.filter(row => row.method === 'turn/start');
  assert.equal(turns.length, 1, 'one turn');
  const params = turns[0].params;
  assert.deepEqual(Object.keys(params).sort(), ['input', 'outputSchema', 'threadId']);
  assert.equal(params.threadId, THREAD);
  assert.equal(params.input.length, 1); assert.equal(params.input[0].type, 'text');
  const { outputSchema } = params;
  assert.equal(outputSchema.type, 'object'); assert.equal(outputSchema.additionalProperties, false);
  assert.deepEqual(outputSchema.required, ['name', 'agents']);
  const agent = outputSchema.properties.agents.items;
  assert.equal(agent.additionalProperties, false);
  assert.deepEqual([...agent.required].sort(), ['doneWhen', 'folders', 'key', 'prompt', 'title', 'waitsFor']);
  assert.deepEqual(Object.keys(agent.properties).sort(), [...agent.required].sort());
});

test('uses the main model when no background model is set, and the engine default when neither is', async () => {
  const fallback = await plan({ background: { model: null, provider: null } });
  const start = fallback.client.sent.find(row => row.method === 'thread/start').params;
  assert.equal(start.model, 'big-model'); assert.equal(start.modelProvider, 'openai');
  const none = await plan({ background: { model: null, provider: null }, main: { model: null, provider: null } });
  const bare = none.client.sent.find(row => row.method === 'thread/start').params;
  assert.equal('model' in bare, false); assert.equal('modelProvider' in bare, false);
  const sameProvider = await plan({ background: { model: 'fast-model', provider: null } });
  assert.equal('modelProvider' in sameProvider.client.sent.find(row => row.method === 'thread/start').params, false, 'a background model without a provider runs on the default provider');
});

test('the prompt carries the goal, the folder list, the limit and the planning rules', async () => {
  const { client } = await plan();
  const prompt = client.sent.find(row => row.method === 'turn/start').params.input[0].text;
  assert.match(prompt, /Build a small notes app/);
  for (const folder of FOLDERS) assert.match(prompt, new RegExp(`^- ${folder}$`, 'm'));
  assert.match(prompt, /at most 4 agents/i);
  assert.match(prompt, /Every agent writes/);
  assert.match(prompt, /markdown file in its (own )?folder/i);
  assert.match(prompt, /split by independent parts, not by role/i);
  assert.match(prompt, /its tests/i);
  assert.match(prompt, /never the whole project/i);
  assert.match(prompt, /same time[^.]*not share a folder/i);
  assert.match(prompt, /waitsFor/); assert.match(prompt, /no loops/i);
  assert.match(prompt, /6 words/);
  assert.match(prompt, /board is empty/i);
  assert.doesNotMatch(prompt, /Keep every existing agent's key/);
});

test('returns the validated plan as { name, agents }', async () => {
  const { result } = await plan();
  assert.deepEqual(result, PLAN);
});

test('reads a plan wrapped in a code fence, and the final answer rather than the commentary before it', async () => {
  const { result } = await plan({ answer: `\`\`\`json\n${JSON.stringify(PLAN)}\n\`\`\``, extra: [{ type: 'agentMessage', id: 'note', text: 'Let me plan.', phase: 'commentary' }] });
  assert.deepEqual(result, PLAN);
});

test('with a board, sends it and the keep-and-fill rule; the plan keeps the keys and fills what was empty', async () => {
  const board = [
    { key: 'agent-1', title: 'Notes API', prompt: 'Keep the API small.', folders: ['api'], doneWhen: ['Smoke test passes'], waitsFor: [] },
    { key: 'agent-2', title: 'Notes screen', prompt: '', folders: [], doneWhen: [], waitsFor: ['agent-1'] },
  ];
  const filled = { name: 'Notes app', agents: [
    { key: 'agent-1', title: 'Notes API', prompt: 'Keep the API small.', folders: ['api'], doneWhen: ['the API tests pass'], waitsFor: [] },
    { key: 'agent-2', title: 'Notes screen', prompt: 'Add the notes screen in web/ with its tests.', folders: ['web'], doneWhen: ['the screen lists notes'], waitsFor: ['agent-1'] },
    { key: 'docs', title: 'Write the notes guide', prompt: 'Write docs/guide.md for the notes app.', folders: ['docs'], doneWhen: ['docs/guide.md exists'], waitsFor: ['agent-2'] },
  ] };
  const { client, result } = await plan({ answer: filled }, {}, { ...BODY, agents: board });
  const prompt = client.sent.find(row => row.method === 'turn/start').params.input[0].text;
  assert.match(prompt, /Keep every existing agent's key/);
  assert.match(prompt, /fill only what is empty \(prompt, folders, doneWhen\)[^.]*unless the goal asks/i);
  for (const row of board) { assert.ok(prompt.includes(`"key": "${row.key}"`)); assert.ok(prompt.includes(`"title": "${row.title}"`)); }
  assert.ok(prompt.includes('Keep the API small.')); assert.ok(prompt.includes('Smoke test passes'), 'its criteria too');
  assert.doesNotMatch(prompt, /board is empty/i);
  assert.deepEqual(result.agents.map(row => row.key), ['agent-1', 'agent-2', 'docs']);
  assert.equal(result.agents[0].prompt, 'Keep the API small.');
  assert.deepEqual(result.agents[1].folders, ['web']);
});

test('an existing agent may keep a folder the user chose that is no longer listed; other agents may not use it', async () => {
  const board = [{ key: 'agent-1', title: 'Old', prompt: 'Work.', folders: ['legacy'], doneWhen: [], waitsFor: [] }];
  const keeps = { name: 'Team', agents: [{ key: 'agent-1', title: 'Old', prompt: 'Work.', folders: ['legacy'], doneWhen: [], waitsFor: [] }] };
  assert.deepEqual((await plan({ answer: keeps }, {}, { ...BODY, agents: board })).result, keeps);
  const other = { name: 'Team', agents: [...keeps.agents, { key: 'new', title: 'New', prompt: 'Work.', folders: ['legacy'], doneWhen: [], waitsFor: [] }] };
  await refused(plan({ answer: other }, {}, { ...BODY, agents: board }), 502, /"new".*"legacy".*not in the project's folder list/);
});

test('a plan may return an existing agent\'s fields empty (the canvas keeps its own), but not a new agent\'s', async () => {
  const board = [{ key: 'agent-1', title: 'Notes API', prompt: 'Keep the API small.', folders: ['api'], doneWhen: ['Smoke test passes'], waitsFor: [] }];
  const empty = { name: 'Team', agents: [{ key: 'agent-1', title: '', prompt: '', folders: [], doneWhen: [], waitsFor: [] }] };
  assert.deepEqual((await plan({ answer: empty }, {}, { ...BODY, agents: board })).result, empty);
  const added = { name: 'Team', agents: [...empty.agents, { key: 'fresh', title: 'Fresh', prompt: '', folders: ['web'], doneWhen: [], waitsFor: [] }] };
  await refused(plan({ answer: added }, {}, { ...BODY, agents: board }), 502, /Agent "fresh".*prompt/);
  const unfoldered = { name: 'Team', agents: [...empty.agents, { key: 'fresh', title: 'Fresh', prompt: 'Work.', folders: [], doneWhen: [], waitsFor: [] }] };
  await refused(plan({ answer: unfoldered }, {}, { ...BODY, agents: board }), 502, /Agent "fresh".*at least one folder/);
});

test('with no folder list every agent must come back with no folders', async () => {
  const bare = { name: 'Team', agents: [{ key: 'a', title: 'Do it', prompt: 'Do it.', folders: [], doneWhen: [], waitsFor: [] }] };
  const { folders: _folders, ...body } = BODY;
  const { client, result } = await plan({ answer: bare }, {}, body);
  assert.deepEqual(result, bare);
  assert.match(client.sent.find(row => row.method === 'turn/start').params.input[0].text, /no folder list/i);
  await refused(plan({ answer: { ...bare, agents: [{ ...bare.agents[0], folders: ['api'] }] } }, {}, body), 502, /not in the project's folder list/);
});

const mutate = change => { const copy = clone(PLAN); change(copy); return copy; };
const REFUSALS = [
  ['an answer that is not JSON', 'sorry, I cannot', /not valid JSON/],
  ['an answer that is not an object', [PLAN], /not valid JSON|must be an object/],
  ['an unknown field on the plan', mutate(plan => { plan.extra = 1; }), /unknown field "extra"/],
  ['an unknown field on an agent', mutate(plan => { plan.agents[0].role = 'tester'; }), /Agent "api".*unknown field "role"/],
  ['a missing field on an agent', mutate(plan => { delete plan.agents[1].doneWhen; }), /Agent "web".*doneWhen/],
  ['a missing name', mutate(plan => { plan.name = ' '; }), /name/],
  ['no agents', mutate(plan => { plan.agents = []; }), /no agents/],
  ['more agents than maxAgents', { name: 'Big', agents: ['a', 'b', 'c', 'd'].map(key => ({ key, title: key, prompt: 'Work.', folders: ['api'], doneWhen: [], waitsFor: [] })) }, /4 agents.*limit is 3/],
  ['a folder that is not in the list', mutate(plan => { plan.agents[0].folders = ['api', 'secrets']; }), /"api".*"secrets".*not in the project's folder list/],
  ['the whole project as a folder', mutate(plan => { plan.agents[0].folders = ['.']; }), /"\."/],
  ['an agent with no folder while folders were given', mutate(plan => { plan.agents[0].folders = []; }), /Agent "api".*at least one folder/],
  ['an agent without a prompt', mutate(plan => { plan.agents[0].prompt = ''; }), /Agent "api".*prompt/],
  ['an agent without a title', mutate(plan => { plan.agents[0].title = ' '; }), /Agent "api".*title/],
  ['a wrong type', mutate(plan => { plan.agents[0].waitsFor = 'web'; }), /Agent "api".*waitsFor/],
  ['two agents with one key', mutate(plan => { plan.agents[1].key = 'api'; }), /same key "api"|share the key "api"/],
  ['a wait for a key that is not in the plan', mutate(plan => { plan.agents[1].waitsFor = ['nope']; }), /"web" waits for "nope"/],
  ['an agent that waits for itself', mutate(plan => { plan.agents[0].waitsFor = ['api']; }), /loop.*api -> api/],
  ['a loop between two agents', mutate(plan => { plan.agents[0].waitsFor = ['web']; }), /loop.*(api -> web -> api|web -> api -> web)/],
  ['a loop through three agents', { name: 'Ring', agents: [['a', 'c'], ['b', 'a'], ['c', 'b']].map(([key, waits]) => ({ key, title: key, prompt: 'Work.', folders: ['api'], doneWhen: [], waitsFor: [waits] })) }, /loop/],
];
for (const [label, answer, pattern] of REFUSALS) {
  test(`refuses ${label} with a clear message and still releases the conversation`, async () => {
    const client = fakeClient({ answer });
    await refused(planCanvas(client, { ...BODY, maxAgents: 3 }), 502, pattern);
    assert.deepEqual(client.methods().slice(-1), ['thread/unsubscribe']);
  });
}

test('a turn that fails is reported with the engine message', async () => {
  const client = fakeClient({ status: 'failed', error: 'The model is not available' });
  await refused(planCanvas(client, BODY), 502, /could not plan.*The model is not available/i);
  assert.ok(client.methods().includes('thread/unsubscribe'));
});

test('times out with a clear error, stops the turn and releases the conversation', async () => {
  const client = fakeClient({ silent: true });
  const started = Date.now();
  await refused(planCanvas(client, BODY, { timeoutMs: 40 }), 504, /did not finish planning within 90 seconds|did not finish planning/);
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(client.sent.slice(-2), [{ method: 'turn/interrupt', params: { threadId: THREAD, turnId: 't1' } }, { method: 'thread/unsubscribe', params: { threadId: THREAD } }]);
  assert.equal(client.bus.listenerCount('side'), 0, 'stops listening');
});

test('releases the ephemeral conversation after a plan, and deletes it if Elpis did not keep it ephemeral', async () => {
  const kept = fakeClient();
  await planCanvas(kept, BODY);
  assert.deepEqual(kept.sent.slice(-1), [{ method: 'thread/unsubscribe', params: { threadId: THREAD } }]);
  assert.equal(kept.methods().includes('thread/delete'), false);
  assert.equal(kept.bus.listenerCount('side'), 0);
  const stored = fakeClient({ ephemeral: false });
  await planCanvas(stored, BODY);
  assert.deepEqual(stored.methods().slice(-2), ['thread/unsubscribe', 'thread/delete']);
  assert.deepEqual(stored.sent.at(-1).params, { threadId: THREAD });
});

test('a failing release does not hide the plan', async () => {
  const client = fakeClient();
  const rpc = client.sideRpc;
  client.sideRpc = async (method, params) => { if (method === 'thread/unsubscribe') throw new BridgeError('gone', 502); return rpc(method, params); };
  assert.deepEqual(await planCanvas(client, BODY), PLAN);
});

test('refuses a request it cannot plan from before starting anything', async () => {
  const cases = [
    [{ ...BODY, goal: '' }, /goal/i], [{ ...BODY, goal: 5 }, /goal/i], [{ ...BODY, goal: 'x'.repeat(8001) }, /goal/i],
    [{ ...BODY, maxAgents: 0 }, /maxAgents/], [{ ...BODY, maxAgents: 2.5 }, /maxAgents/], [{ ...BODY, maxAgents: '4' }, /maxAgents/], [{ ...BODY, maxAgents: 129 }, /maxAgents/],
    [{ goal: 'x' }, /maxAgents/],
    [{ ...BODY, cwd: 'relative/dir' }, /absolute/i], [{ ...BODY, cwd: 5 }, /working directory/i],
    [{ ...BODY, folders: 'api' }, /folders/i], [{ ...BODY, folders: [5] }, /folder/i], [{ ...BODY, folders: ['/etc'] }, /relative/i], [{ ...BODY, folders: ['a/../../b'] }, /relative/i], [{ ...BODY, folders: ['a\\b'] }, /relative/i],
    [{ ...BODY, agents: 'none' }, /agents/i], [{ ...BODY, agents: [{ key: 'a' }] }, /agents/i], [{ ...BODY, agents: [{ key: 'a', title: 't', prompt: 'p', folders: 'x', doneWhen: [], waitsFor: [] }] }, /folders/i],
    [{ ...BODY, agents: [{ key: 'a', title: 't', prompt: 'p', folders: [], doneWhen: 'x', waitsFor: [] }] }, /doneWhen/i],
    [{ ...BODY, agents: [{ key: 'a', title: 't', prompt: 'p', folders: [], doneWhen: [], waitsFor: [], role: 'x' }] }, /Unsupported request fields/],
    [{ ...BODY, agents: [{ key: 'a', title: 't', prompt: 'p', folders: [], doneWhen: [], waitsFor: [] }, { key: 'a', title: 't', prompt: 'p', folders: [], doneWhen: [], waitsFor: [] }] }, /same key/i],
    [{ ...BODY, extra: true }, /Unsupported request fields/], [null, /Unsupported request fields/],
  ];
  for (const [body, pattern] of cases) {
    const client = fakeClient();
    await refused(planCanvas(client, body), 400, pattern);
    assert.equal(client.sent.length, 0, `nothing started for ${JSON.stringify(body)?.slice(0, 80)}`);
  }
});

test('a client that lists folders but no agents and no cwd still plans', async () => {
  const { client, result } = await plan({}, {}, { goal: 'Build a small notes app', folders: FOLDERS, maxAgents: 3 });
  assert.deepEqual(result, PLAN);
  assert.equal('cwd' in client.sent.find(row => row.method === 'thread/start').params, false);
});

/** The real client with a fake engine socket: side conversations stay out of the app's events. */
function engine() {
  const socket = new EventEmitter(); socket.sent = [];
  const reply = (id, result) => queueMicrotask(() => socket.emit('message', JSON.stringify({ id, result })));
  socket.send = raw => {
    const request = JSON.parse(raw); socket.sent.push(request);
    if (request.id === undefined) return;
    reply(request.id, request.method === 'thread/start' ? { thread: { id: THREAD, ephemeral: request.params.ephemeral === true } } : {});
  };
  socket.close = () => socket.emit('close');
  const client = new DesktopClient(socket);
  const events = [], side = [];
  client.on('event', value => events.push(value)); client.on('side', value => side.push(value));
  const notify = (method, params) => socket.emit('message', JSON.stringify({ method, params }));
  return { client, socket, events, side, notify };
}

test('sideRpc starts only ephemeral conversations and keeps them out of the app\'s events', async t => {
  const { client, socket, events, side, notify } = engine(); t.after(() => client.close());
  await client.sideRpc('thread/start', { cwd: '/work' });
  assert.equal(socket.sent.at(-1).params.ephemeral, true, 'always ephemeral');
  notify('thread/started', { thread: { id: THREAD } });
  notify('thread/status/changed', { threadId: THREAD, status: { type: 'active' } });
  notify('turn/completed', { threadId: THREAD, turn: { id: 't1', status: 'completed' } });
  assert.deepEqual(side.map(row => row.method), ['thread/started', 'thread/status/changed', 'turn/completed']);
  assert.deepEqual(events.filter(row => row.type === 'message'), [], 'the app is told nothing');
  const other = '00000000-0000-0000-0000-0000000000b2';
  notify('thread/started', { thread: { id: other } });
  assert.equal(events.filter(row => row.type === 'message' && row.data.method === 'thread/started').length, 1, 'other chats are still announced');
  assert.equal(side.length, 3);
});

test('sideRpc allows only the planner\'s requests, and only on its own conversations', async t => {
  const { client, socket } = engine(); t.after(() => client.close());
  await assert.rejects(client.sideRpc('thread/list', {}), BridgeError);
  await assert.rejects(client.sideRpc('turn/start', { threadId: THREAD, input: [] }), BridgeError, 'a conversation it did not start');
  await client.sideRpc('thread/start', {});
  await client.sideRpc('turn/start', { threadId: THREAD, input: [] });
  await client.sideRpc('turn/interrupt', { threadId: THREAD, turnId: 't1' });
  await client.sideRpc('thread/unsubscribe', { threadId: THREAD });
  assert.deepEqual(socket.sent.filter(row => row.method !== 'initialize').map(row => row.method), ['thread/start', 'turn/start', 'turn/interrupt', 'thread/unsubscribe']);
  await assert.rejects(client.sideRpc('thread/delete', { threadId: '00000000-0000-0000-0000-0000000000b3' }), BridgeError);
});

test('a closed side conversation is forgotten', async t => {
  const { client, side, events, notify } = engine(); t.after(() => client.close());
  await client.sideRpc('thread/start', {});
  notify('thread/closed', { threadId: THREAD });
  assert.deepEqual(side.map(row => row.method), ['thread/closed']);
  notify('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
  assert.equal(side.length, 1);
  assert.equal(events.filter(row => row.type === 'message').length, 1, 'later news about it is the app\'s again');
});

async function session(t, client) {
  const app = await startDesktopServer({ client, staticDir: '/tmp' }); t.after(() => app.close());
  const url = new URL(app.url), token = new URLSearchParams(url.hash.slice(1)).get('token');
  const auth = await fetch(url.origin + '/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin }, body: JSON.stringify({ token }) });
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  return { origin: url.origin, cookie, post: (body, headers = {}) => fetch(`${url.origin}/api/canvas/plan`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url.origin, ...headers }, body: JSON.stringify(body) }) };
}

test('POST /api/canvas/plan needs the session, answers the plan, and explains a refusal', async t => {
  const client = fakeClient();
  const { cookie, post, origin } = await session(t, client);
  assert.equal((await post(BODY)).status, 401);
  assert.equal(client.sent.length, 0);
  const ok = await post(BODY, { Cookie: cookie });
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), PLAN);
  const bad = await post({ ...BODY, maxAgents: 0 }, { Cookie: cookie });
  assert.equal(bad.status, 400); assert.match((await bad.json()).error, /maxAgents/);
  const sizes = fakeClient({ answer: mutate(plan => { plan.agents[0].folders = ['secrets']; }) });
  const second = await session(t, sizes);
  const refusedPlan = await second.post(BODY, { Cookie: second.cookie });
  assert.equal(refusedPlan.status, 502); assert.match((await refusedPlan.json()).error, /not in the project's folder list/);
  const get = await fetch(`${origin}/api/canvas/plan`, { headers: { Cookie: cookie } });
  assert.notEqual(get.status, 200);
});
