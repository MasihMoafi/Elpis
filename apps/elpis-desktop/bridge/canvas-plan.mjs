import path from 'node:path';
import { BridgeError, object, text, threadId } from './client.mjs';

/** "Elpis handle it" on the agents canvas (POST /api/canvas/plan): a fast model turns a goal into a team of agents.
 * One turn in an ephemeral, read-only conversation on the background model, answered as JSON the schema fixes, then
 * checked strictly: the canvas gets a plan it can draw and run, or a clear refusal. */
export const PLAN_TIMEOUT_MS = 90000;
const LIMIT = 128;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const AGENT_FIELDS = ['key', 'title', 'prompt', 'folders', 'doneWhen', 'waitsFor'];

const strings = { type: 'array', items: { type: 'string' } };
const string = { type: 'string' };
/** Every property required and nothing extra, as strict structured output asks. */
export const PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['name', 'agents'],
  properties: {
    name: string,
    agents: { type: 'array', items: { type: 'object', additionalProperties: false, required: AGENT_FIELDS,
      properties: { key: string, title: string, prompt: string, folders: strings, doneWhen: strings, waitsFor: strings } } },
  },
};

const refuse = reason => new BridgeError(`Elpis returned a plan that cannot be used: ${reason}`, 502);

// ---- The request ---------------------------------------------------------------------------------------------

function list(value, label, { max = 400, size = 500 } = {}) {
  if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || item.length > size)) throw new BridgeError(`Invalid ${label}: give a list of text`);
  return value;
}
const sameKey = key => new BridgeError(`Two agents on the board share the same key "${key}"`);

function folderList(value) {
  if (value === undefined) return [];
  const folders = list(value, 'folders', { size: 300 });
  for (const folder of folders) {
    if (!folder || folder.startsWith('/') || /[\\\0]/.test(folder) || folder.split('/').some(part => !part || part === '.' || part === '..')) throw new BridgeError('Folders must be repository-relative paths');
  }
  return [...new Set(folders)];
}

function boardOf(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > LIMIT) throw new BridgeError('Invalid agents: give the current board as a list');
  const keys = new Set();
  return value.map(entry => {
    object(entry, AGENT_FIELDS);
    if (typeof entry.key !== 'string' || !KEY.test(entry.key)) throw new BridgeError('Invalid agents: every agent needs a key');
    if (keys.has(entry.key)) throw sameKey(entry.key);
    keys.add(entry.key);
    for (const field of ['title', 'prompt']) if (typeof entry[field] !== 'string' || entry[field].length > 8000) throw new BridgeError(`Invalid agents: "${entry.key}" needs a ${field} (it may be empty)`);
    return { key: entry.key, title: entry.title, prompt: entry.prompt, folders: list(entry.folders, 'agents (folders)', { size: 300 }),
      doneWhen: list(entry.doneWhen ?? [], 'agents (doneWhen)', { max: 50 }), waitsFor: list(entry.waitsFor, 'agents (waitsFor)', { max: LIMIT, size: 64 }) };
  });
}

function parseRequest(input) {
  object(input, ['goal', 'cwd', 'folders', 'agents', 'maxAgents']);
  const goal = text(input.goal, 'goal', 8000).trim();
  if (!Number.isSafeInteger(input.maxAgents) || input.maxAgents < 1 || input.maxAgents > LIMIT) throw new BridgeError(`Invalid maxAgents: give a whole number from 1 to ${LIMIT}`);
  if (input.cwd !== undefined && !path.isAbsolute(text(input.cwd, 'working directory', 4096))) throw new BridgeError('Working directory must be absolute');
  return { goal, cwd: input.cwd, folders: folderList(input.folders), agents: boardOf(input.agents), maxAgents: input.maxAgents };
}

// ---- The prompt ----------------------------------------------------------------------------------------------

function promptFor({ goal, folders, agents, maxAgents }) {
  const rules = [
    `Use at most ${maxAgents} agents. A small goal needs one or two.`,
    'Every agent writes: code or, for research and decisions, a markdown file in its own folder. No agent only reads or reports.',
    'Split by independent parts, not by role. An agent handling a feature also handles its tests. Never add a separate tester, reviewer or planner agent.',
    'folders: copy them from the folder list, the narrowest ones the agent writes; never the whole project. Two agents that run at the same time must not share a folder. Every agent also gets its own folder for its report, so an agent that changes no project files needs none.',
    'waitsFor: the keys of the agents this one builds on (a DAG, no loops). Agents that build on nothing wait for nothing, so they run in parallel.',
    'prompt: short and concrete (what to build, where, what to leave alone). title: plain language, 6 words at most. doneWhen: one to three checks anyone can verify. key: a short lowercase word with dashes. name: two to five plain words for the team.',
    ...agents.length ? ["Keep every existing agent's key. For an existing agent, fill only what is empty (prompt, folders, doneWhen) unless the goal asks to change it. Return a field you leave alone as it is, or empty: the canvas keeps what it has. Add agents for parts the board lacks; leave an agent out only if the goal asks."] : [],
  ];
  return [
    'You design a team of coding agents for a canvas. Turn the goal into the smallest team that achieves it. Answer only with the JSON the schema asks for. Use no tools: work from what is below.',
    `Goal:\n${goal}`,
    folders.length ? `Project folders (repository-relative). An agent's folders must be copied from this list, exactly:\n${folders.map(folder => `- ${folder}`).join('\n')}`
      : "No folder list was given, so every agent's folders must be an empty list.",
    agents.length ? `Current board (the agents the user already has; waitsFor lists the keys each builds on):\n${JSON.stringify(agents, null, 2)}` : 'The board is empty: every agent is new.',
    `Rules:\n${rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n')}`,
  ].join('\n\n');
}

// ---- The conversation ----------------------------------------------------------------------------------------

/** Follows one side conversation to the end of its turn. `stop` must be called when done; `ended` tells whether the turn finished. */
function follow(client, id, timeoutMs) {
  const state = { ended: false };
  let listener, timer, final, last;
  state.answer = new Promise((resolve, reject) => {
    listener = ({ method, params }) => {
      if (params?.threadId !== id) return;
      if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
        last = params.item.text;
        if (params.item.phase !== 'commentary') final = params.item.text;
      }
      if (method !== 'turn/completed' || params.turn?.status === 'inProgress') return;
      state.ended = true;
      const { status, error, items } = params.turn ?? {};
      if (status !== 'completed') return reject(new BridgeError(`Elpis could not plan: ${error?.message ?? `the turn was ${status ?? 'lost'}`}`, 502));
      const answer = final ?? last ?? items?.findLast?.(item => item?.type === 'agentMessage' && typeof item.text === 'string')?.text;
      if (answer === undefined) return reject(new BridgeError('Elpis could not plan: it gave no answer', 502));
      resolve(answer);
    };
    timer = setTimeout(() => reject(new BridgeError(`Elpis did not finish planning within ${timeoutMs / 1000} seconds. Try again, or add the agents yourself.`, 504)), timeoutMs);
    client.on('side', listener);
  });
  state.answer.catch(() => {});
  state.stop = () => { clearTimeout(timer); client.off('side', listener); };
  return state;
}

/** Stops a turn that is still running, lets the conversation go, and removes it if Elpis kept it. */
async function release(client, id, turnId, ended, kept) {
  const quietly = (method, params) => client.sideRpc(method, params).catch(() => {});
  if (!ended && turnId) await quietly('turn/interrupt', { threadId: id, turnId });
  await quietly('thread/unsubscribe', { threadId: id });
  if (kept) await quietly('thread/delete', { threadId: id });
}

// ---- The answer ----------------------------------------------------------------------------------------------

function parse(answer) {
  let body = answer.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced) body = fenced[1];
  try { return JSON.parse(body); } catch { throw refuse('the answer was not valid JSON'); }
}
function shape(value, keys, who) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw refuse(`${who} must be an object`);
  const unknown = Object.keys(value).find(key => !keys.includes(key));
  if (unknown !== undefined) throw refuse(`${who} has an unknown field "${unknown}"`);
  return value;
}
function textList(agent, field, label) {
  if (!Array.isArray(agent[field]) || agent[field].some(item => typeof item !== 'string' || item.length > 500)) throw refuse(`${label} has ${field} that is not a list of text`);
  return agent[field];
}

function check(answer, { folders, agents: board, maxAgents }) {
  const plan = shape(parse(answer), ['name', 'agents'], 'The plan');
  if (typeof plan.name !== 'string' || !plan.name.trim() || plan.name.length > 200) throw refuse('the plan has no name');
  if (!Array.isArray(plan.agents) || !plan.agents.length) throw refuse('the plan has no agents');
  if (plan.agents.length > maxAgents) throw refuse(`the plan has ${plan.agents.length} agents; the limit is ${maxAgents}`);
  const known = new Map(board.map(agent => [agent.key, agent])), listed = new Set(folders), seen = new Set();
  const agents = plan.agents.map((raw, index) => {
    const label = `Agent ${typeof raw?.key === 'string' && raw.key ? `"${raw.key}"` : `#${index + 1}`}`;
    const agent = shape(raw, AGENT_FIELDS, label);
    for (const field of AGENT_FIELDS) if (!(field in agent)) throw refuse(`${label} is missing ${field}`);
    if (typeof agent.key !== 'string' || !KEY.test(agent.key)) throw refuse(`${label} needs a key of letters, digits, dashes and underscores`);
    if (seen.has(agent.key)) throw refuse(`Two agents share the key "${agent.key}"`);
    seen.add(agent.key);
    const existing = known.get(agent.key);
    // An existing agent may come back empty: the canvas keeps what it has.
    for (const field of ['title', 'prompt']) {
      if (typeof agent[field] !== 'string' || agent[field].length > (field === 'title' ? 200 : 8000)) throw refuse(`${label} has a ${field} that is not text of a usable length`);
      if (!agent[field].trim() && !existing) throw refuse(`${label} has no ${field}`);
    }
    const own = new Set(existing?.folders);
    const chosen = [...new Set(textList(agent, 'folders', label))];
    for (const folder of chosen) if (!listed.has(folder) && !own.has(folder)) throw refuse(`${label} uses the folder "${folder}", which is not in the project's folder list`);
    if (!chosen.length && folders.length && !existing) throw refuse(`${label} needs at least one folder`);
    return { key: agent.key, title: agent.title.trim(), prompt: agent.prompt.trim(), folders: chosen, doneWhen: textList(agent, 'doneWhen', label), waitsFor: [...new Set(textList(agent, 'waitsFor', label))] };
  });
  for (const agent of agents) for (const key of agent.waitsFor) if (!seen.has(key)) throw refuse(`Agent "${agent.key}" waits for "${key}", which is not in the plan`);
  const waits = new Map(agents.map(agent => [agent.key, agent.waitsFor])), done = new Set();
  const visit = (key, trail) => {
    if (trail.includes(key)) throw refuse(`the plan has a loop: ${[...trail.slice(trail.indexOf(key)), key].join(' -> ')}`);
    if (done.has(key)) return;
    for (const next of waits.get(key)) visit(next, [...trail, key]);
    done.add(key);
  };
  for (const agent of agents) visit(agent.key, []);
  return { name: plan.name.trim(), agents };
}

// ---- The route's operation -----------------------------------------------------------------------------------

/** Plans a team for `input.goal`. `client` is the bridge's DesktopClient (settings, sideRpc and 'side' notifications). */
export async function planCanvas(client, input, { timeoutMs = PLAN_TIMEOUT_MS } = {}) {
  const request = parseRequest(input);
  const { main, background } = await client.settings();
  const choice = background?.model ? background : main;
  const started = await client.sideRpc('thread/start', { ephemeral: true, ...(choice?.model ? { model: choice.model, ...(choice.provider ? { modelProvider: choice.provider } : {}) } : {}),
    ...(request.cwd ? { cwd: request.cwd } : {}), approvalPolicy: 'never', sandbox: 'read-only' });
  const id = threadId(started.thread?.id);
  const turn = follow(client, id, timeoutMs);
  let turnId, answer;
  try {
    const result = await client.sideRpc('turn/start', { threadId: id, input: [{ type: 'text', text: promptFor(request), text_elements: [] }], outputSchema: PLAN_SCHEMA });
    turnId = result?.turn?.id;
    answer = await turn.answer;
  } finally {
    turn.stop();
    await release(client, id, turnId, turn.ended, started.thread.ephemeral !== true);
  }
  return check(answer, request);
}
