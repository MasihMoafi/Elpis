import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BridgeError, elpisHome, object, text } from './client.mjs';
import { handoffText, runAcpNode } from './acp-nodes.mjs';

// Excalidraw remains the source of truth: bound arrows, not a second edge store.
export function agentGraph(elements, selected) {
  const cards = elements.filter(e => !e.isDeleted && e.type === 'rectangle' && e.customData?.loveAgent);
  if (cards.length > 64) throw new BridgeError('Run at most 64 agents at once');
  const nodes = new Map(cards.map(e => {
    const a = e.customData.loveAgent;
    for (const [key, limit] of [['name', 120], ['prompt', 32000], ['model', 200], ['provider', 200]]) text(a[key], `agent ${key}`, limit);
    if (typeof a.task !== 'string' || a.task.length > 16000) throw new BridgeError('Invalid agent task');
    return [e.id, { ...a, id: e.id, incoming: [], outgoing: [] }];
  }));
  if (!nodes.has(selected)) throw new BridgeError('Select an agent on the board');
  for (const e of elements) {
    if (e.isDeleted || e.type !== 'arrow') continue;
    let a = e.startBinding?.elementId, b = e.endBinding?.elementId;
    if (e.startArrowhead === 'arrow' && !e.endArrowhead) [a, b] = [b, a];
    else if (e.endArrowhead !== 'arrow' || e.startArrowhead) continue;
    if (nodes.has(a) && nodes.has(b)) {
      if (!nodes.get(b).incoming.includes(a)) nodes.get(b).incoming.push(a);
      if (!nodes.get(a).outgoing.includes(b)) nodes.get(a).outgoing.push(b);
    }
  }
  const component = new Set();
  const collect = id => { if (component.has(id)) return; component.add(id); const n = nodes.get(id); [...n.incoming, ...n.outgoing].forEach(collect); };
  collect(selected);
  const ordered = [], visiting = new Set(), done = new Set();
  const visit = id => {
    if (visiting.has(id)) throw new BridgeError('The agents have a loop. Remove an arrow before running.');
    if (done.has(id)) return;
    visiting.add(id);
    const node = nodes.get(id);
    if (!node.incoming.length && !node.task.trim()) throw new BridgeError(`Give ${node.name} a task before running`);
    node.incoming.forEach(visit); visiting.delete(id); done.add(id); ordered.push(node);
  };
  component.forEach(visit);
  return ordered;
}

// Where Elpis is installed, as desktop/runtime.mjs finds it: the runtime executable, and its provider tools beside it.
function installation(env) {
  const selected = env.ELPIS_ENGINE_BIN || path.join(os.homedir(), '.local', 'bin', 'elpis-next');
  let engine;
  try { engine = fs.realpathSync(selected); }
  catch { throw new BridgeError('Install Elpis before running agents. The Elpis runtime executable could not be found.', 503); }
  return { engine, tools: path.join(path.dirname(engine), 'tools', 'elpis-claude') };
}
const present = file => {
  if (!fs.existsSync(file)) throw new BridgeError(`This Elpis installation has no ${path.basename(file)} (${file}). Update Elpis to run agents over ACP.`, 503);
  return file;
};
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');

/** ACP agents the person configured in $ELPIS_HOME/acp-agents.json, by the provider name a card uses:
 * `{ "fx": { "command": "fx", "args": ["acp"], "env": { … } } }`. Kept out of the drawing, which can come from anyone. */
export function configuredAgents(env = process.env) {
  const file = path.join(elpisHome(env), 'acp-agents.json');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw new BridgeError(`Could not read ${file}`, 500); }
  let agents;
  try { agents = JSON.parse(raw); } catch { throw new BridgeError(`${file} is not valid JSON`, 400); }
  if (!agents || typeof agents !== 'object' || Array.isArray(agents)) throw new BridgeError(`${file} must map provider names to ACP agent commands`, 400);
  for (const [name, agent] of Object.entries(agents)) {
    if (typeof agent?.command !== 'string' || !agent.command || (agent.args !== undefined && !strings(agent.args))
      || (agent.env !== undefined && (typeof agent.env !== 'object' || Array.isArray(agent.env) || !Object.values(agent.env).every(value => typeof value === 'string')))) {
      throw new BridgeError(`${file}: "${name}" needs a command, and optional args (strings) and env (strings)`, 400);
    }
  }
  return agents;
}

/** The ACP agent process that runs one card: a configured command for the card's provider, claude-agent-acp for
 * `claude/…` models, agy-acp.mjs for `agy/…`, and otherwise the Elpis ACP agent on the card's model and provider. */
export function loveNodeSpec(node, env = process.env) {
  const base = { name: node.name, instructions: node.prompt };
  const agents = configuredAgents(env), configured = Object.hasOwn(agents, node.provider) ? agents[node.provider] : null;
  // Another program's ACP agent has no Elpis instructions channel; the card's prompt leads its prompt instead.
  if (configured) return { ...base, instructionsInPrompt: true, command: configured.command, args: configured.args ?? [], env: configured.env ?? {}, ...(node.model ? { model: node.model } : {}) };
  const nodeBin = env.ELPIS_NODE_BIN || 'node';
  if (node.model.startsWith('claude/')) {
    const { tools } = installation(env);
    return { ...base, command: nodeBin, args: [present(path.join(tools, 'node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js'))],
      env: { CLAUDE_CODE_EXECUTABLE: env.CLAUDE_CODE_EXECUTABLE || path.join(os.homedir(), '.local', 'bin', 'claude') }, model: node.model.slice('claude/'.length) };
  }
  if (node.model.startsWith('agy/')) return { ...base, command: nodeBin, args: [present(path.join(installation(env).tools, 'agy-acp.mjs'))], model: node.model.slice('agy/'.length) };
  const { engine, tools } = installation(env);
  return { ...base, command: nodeBin, args: [present(env.ELPIS_ACP_AGENT || path.join(tools, 'elpis-acp-agent.mjs')), ...(node.model ? ['--model', node.model] : []), ...(node.provider ? ['--provider', node.provider] : [])],
    env: { ELPIS_ENGINE_BIN: engine, ELPIS_HOME: elpisHome(env) }, meta: { elpis: { name: `Love Spot · ${node.name}` } }, elpis: true };
}

/** Runs a card's connected agents in order, each as its own ACP agent process (bridge/acp-nodes.mjs): a card's final
 * answer reaches the cards its arrows point to through their session/prompt, and nothing else passes between them.
 * A permission request waits on its card until the panel answers it (`answer`). */
export function createLoveAgents(store, { timeoutMs = 300000, nodeSpec = loveNodeSpec, env = process.env } = {}) {
  let running = false, saving = Promise.resolve();
  const waiting = new Map(); // card id -> the permission request it shows: { options, resolve }
  // Changes are saved one after another, so a permission shown mid-run is not lost to a concurrent save.
  const patch = (id, change) => (saving = saving.catch(() => {}).then(async () => {
    const { scene } = await store.read();
    const elements = scene.elements.map(e => e.id !== id || e.isDeleted ? e : { ...e, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2147483647), updated: Date.now(), customData: { ...e.customData, loveAgent: { ...e.customData.loveAgent, ...change } } });
    await store.save({ ...scene, elements });
  }));
  // A change shown while the run goes on; a failed save must not stop the run (or the bridge).
  const shown = (id, change) => { patch(id, change).catch(error => console.warn('Love Spot could not save an agent update', String(error?.message ?? error).slice(0, 200))); };
  const ask = (id, request) => {
    if (waiting.has(id)) return null; // one question at a time per card; a second is refused
    const options = (Array.isArray(request?.options) ? request.options : []).slice(0, 8).map(option => ({ optionId: String(option.optionId).slice(0, 200), name: String(option.name ?? option.optionId).slice(0, 200), kind: String(option.kind ?? '').slice(0, 40) }));
    return new Promise(resolve => {
      waiting.set(id, { options, resolve });
      shown(id, { status: 'waiting', permission: { title: String(request?.toolCall?.title || 'The agent asks to continue').slice(0, 500), options } });
    });
  };
  return {
    async run(input) {
      object(input, ['id', 'cwd']); text(input.id, 'agent ID', 200);
      if (input.cwd !== undefined && !path.isAbsolute(text(input.cwd, 'working folder', 4096))) throw new BridgeError('Working folder must be absolute');
      if (running) throw new BridgeError('A Love Spot agent run is already running', 409);
      running = true;
      try {
        const { scene } = await store.read();
        const nodes = agentGraph(scene.elements, input.id), answers = new Map(), results = [];
        const cwd = input.cwd ?? os.homedir();
        for (const node of nodes) {
          try {
            const inputs = node.incoming.map(id => ({ name: nodes.find(n => n.id === id).name, answer: answers.get(id) }));
            handoffText(node.task, inputs); // an oversized handoff fails before the agent starts
            const spec = nodeSpec(node, env);
            await patch(node.id, { status: 'running', error: '', output: '', threadId: '', sessionId: '', permission: null });
            const result = await runAcpNode(spec, { task: node.task, inputs }, {
              cwd, timeoutMs,
              onSession: id => shown(node.id, { sessionId: id, ...(spec.elpis ? { threadId: id } : {}) }),
              onPermission: request => ask(node.id, request),
            });
            answers.set(node.id, result.answer);
            await patch(node.id, { status: 'completed', output: result.answer, permission: null });
            results.push({ id: node.id, sessionId: result.sessionId, ...(spec.elpis ? { threadId: result.sessionId } : {}), output: result.answer });
          } catch (error) {
            await patch(node.id, { status: 'failed', error: error.message, permission: null });
            throw error;
          } finally { waiting.delete(node.id); }
        }
        return { results };
      } finally { running = false; }
    },
    /** The panel's answer to a card's waiting permission request: one of the options the agent offered. */
    answer(input) {
      object(input, ['id', 'optionId']); text(input.id, 'agent ID', 200); text(input.optionId, 'option', 200);
      const pending = waiting.get(input.id);
      if (!pending) throw new BridgeError('No permission request is waiting for this agent', 409);
      if (!pending.options.some(option => option.optionId === input.optionId)) throw new BridgeError('Choose one of the options the agent offered');
      waiting.delete(input.id);
      pending.resolve(input.optionId);
      shown(input.id, { status: 'running', permission: null });
      return { answered: true };
    },
  };
}

