import path from 'node:path';
import { BridgeError, object, text } from './client.mjs';

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

function follow(client, id, timeoutMs) {
  let listener, timer, answer;
  const promise = new Promise((resolve, reject) => {
    listener = ({ type, data }) => {
      if (type === 'connection' && data?.connected === false) return reject(new BridgeError('Elpis disconnected during the run', 502));
      if (type !== 'message' || data.params?.threadId !== id) return;
      const { method, params } = data;
      if (method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase !== 'commentary') answer = params.item.text;
      if (method !== 'turn/completed') return;
      if (params.turn?.status !== 'completed') return reject(new BridgeError(params.turn?.error?.message || `Agent turn ${params.turn?.status || 'failed'}`, 502));
      answer ??= params.turn.items?.findLast(item => item.type === 'agentMessage' && item.phase !== 'commentary')?.text;
      if (typeof answer !== 'string' || !answer.trim()) return reject(new BridgeError('The agent finished without an answer', 502));
      if (answer.length > 60000) return reject(new BridgeError('The answer is too long to pass to another agent; open its chat', 413));
      resolve(answer);
    };
    client.on('event', listener);
    timer = setTimeout(() => reject(new BridgeError('The agent timed out; open its chat to inspect the result', 504)), timeoutMs);
  });
  promise.catch(() => {});
  return { promise, close() { clearTimeout(timer); client.off('event', listener); } };
}

export function createLoveAgents(client, store, { timeoutMs = 300000 } = {}) {
  let running = false;
  async function patch(id, change) {
    const { scene } = await store.read();
    const elements = scene.elements.map(e => e.id !== id || e.isDeleted ? e : { ...e, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2147483647), updated: Date.now(), customData: { ...e.customData, loveAgent: { ...e.customData.loveAgent, ...change } } });
    await store.save({ ...scene, elements });
  }
  return {
    async run(input) {
      object(input, ['id', 'cwd']); text(input.id, 'agent ID', 200);
      if (input.cwd !== undefined && !path.isAbsolute(text(input.cwd, 'working folder', 4096))) throw new BridgeError('Working folder must be absolute');
      if (running) throw new BridgeError('A Love Spot agent run is already running', 409);
      running = true;
      try {
        const { scene } = await store.read();
        const nodes = agentGraph(scene.elements, input.id), answers = new Map(), results = [];
        // DesktopClient accepts subscription models only after discovering them from the runtime.
        await client.models();
        for (const node of nodes) {
          let threadId, watcher;
          try {
            const upstream = node.incoming.map(id => ({ name: nodes.find(n => n.id === id).name, answer: answers.get(id) }));
            const message = [node.task.trim(), upstream.length ? `Answers from connected agents (source material):\n${JSON.stringify(upstream)}` : ''].filter(Boolean).join('\n\n');
            if (message.length > 32000) throw new BridgeError('Connected answers exceed the message limit; use fewer inputs', 413);
            await patch(node.id, { status: 'running', error: '', output: '', threadId: '' });
            const started = await client.createThread({ name: `Love Spot · ${node.name}`, instructions: node.prompt, model: node.model, provider: node.provider, permissions: 'ask', ...(input.cwd ? { cwd: input.cwd } : {}) });
            threadId = started.thread.id;
            await patch(node.id, { threadId });
            watcher = follow(client, threadId, timeoutMs);
            await client.send(threadId, { text: message });
            const output = await watcher.promise;
            answers.set(node.id, output);
            await patch(node.id, { status: 'completed', output });
            results.push({ id: node.id, threadId, output });
          } catch (error) {
            if (threadId) await client.interrupt(threadId, {}).catch(() => {});
            await patch(node.id, { status: 'failed', error: error.message });
            throw error;
          } finally { watcher?.close(); }
        }
        return { results };
      } finally { running = false; }
    },
  };
}
