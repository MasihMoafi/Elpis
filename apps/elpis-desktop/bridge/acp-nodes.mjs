import { spawn } from 'node:child_process';
import path from 'node:path';
import { BridgeError } from './client.mjs';
import { childEnv } from './tools.mjs';

// Elpis agents reach each other only over ACP (Agent Client Protocol v1, https://agentclientprotocol.com): every agent
// node is an ACP agent process (the Elpis ACP agent, tools/elpis-claude/elpis-acp-agent.mjs, per model;
// claude-agent-acp; agy-acp.mjs; or a configured command such as `fx acp`), and this module is the ACP client that
// runs one node and hands its final answer to the next node's session/prompt. No dependencies: the desktop app has no
// ACP SDK, so the client is the few JSON-RPC calls below, tested against agents built on the official SDK.

const MAX_MESSAGE = 32000, MAX_ANSWER = 60000, TAIL = 600;
const CANCELLED = Symbol('cancelled');

/** The text a node is prompted with: its task, then the final answers of the nodes connected to it, with their names. */
export function handoffText(task, inputs = [], instructions) {
  const upstream = inputs.map(({ name, answer }) => ({ name, answer }));
  const text = [instructions?.trim() ? `Instructions:\n${instructions.trim()}` : '', String(task ?? '').trim(),
    upstream.length ? `Answers from connected agents (source material):\n${JSON.stringify(upstream)}` : ''].filter(Boolean).join('\n\n');
  if (text.length > MAX_MESSAGE) throw new BridgeError('Connected answers exceed the message limit; use fewer inputs', 413);
  if (!text) throw new BridgeError('Give the agent a task before running');
  return text;
}

/** The final answer of a turn: the last agent message, without progress text. A message ends where another starts
 * (a new messageId) or a tool call comes; chunks the Elpis agent marks as commentary never count. */
class Answer {
  #segments = []; #open = null;
  add(update) {
    if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') { this.#open = null; return; }
    if (update?.sessionUpdate !== 'agent_message_chunk' || update.content?.type !== 'text') return;
    const id = update.messageId ?? null, commentary = update._meta?.elpis?.phase === 'commentary';
    if (!this.#open || this.#open.id !== id || this.#open.commentary !== commentary) this.#segments.push(this.#open = { id, commentary, text: '' });
    this.#open.text += update.content.text;
  }
  get text() { return this.#segments.filter(segment => !segment.commentary && segment.text.trim()).at(-1)?.text; }
}

/** One ACP agent process over stdio (newline-delimited JSON-RPC 2.0). */
class AcpProcess {
  #pending = new Map(); #seq = 0; #stderr = '';
  constructor(spec, cwd, { onRequest, onNotification }) {
    const name = spec.name || 'The agent';
    const env = Object.fromEntries(Object.entries({ ...process.env, ...spec.env }).filter(([, value]) => typeof value === 'string'));
    this.child = spawn(spec.command, spec.args ?? [], { cwd, env: childEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {});
    this.child.stderr.on('data', data => { this.#stderr = (this.#stderr + data).slice(-4000); });
    let buffer = '';
    this.child.stdout.on('data', data => {
      buffer += data;
      for (let i; (i = buffer.indexOf('\n')) >= 0;) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id !== undefined && !message.method) {
          const pending = this.#pending.get(message.id); this.#pending.delete(message.id);
          if (message.error) { const error = new BridgeError(`${name}: ${String(message.error.message ?? 'request refused').slice(0, 1000)}`, 502); if (typeof message.error.data?.errorKind === 'string') error.errorKind = message.error.data.errorKind; pending?.reject(error); }
          else pending?.resolve(message.result);
        } else if (message?.id !== undefined) {
          Promise.resolve(onRequest(message.method, message.params)).then(
            result => this.#write({ id: message.id, result }),
            error => this.#write({ id: message.id, error: { code: error?.code ?? -32603, message: error?.message ?? 'Internal error' } }));
        } else if (message?.method) onNotification(message.method, message.params);
      }
    });
    // Settles (never rejects) once the process is gone, with the error to report if it was not expected.
    this.ended = new Promise(resolve => {
      const end = error => { for (const pending of this.#pending.values()) pending.reject(error); this.#pending.clear(); this.gone = true; resolve(error); };
      this.child.once('error', error => end(new BridgeError(`Could not start ${name} (${spec.command}): ${error.message}`, 502)));
      this.child.once('close', (code, signal) => {
        const tail = this.#stderr.trim().slice(-TAIL);
        end(new BridgeError(`${name} exited (${signal ? `signal ${signal}` : `code ${code}`}) before answering${tail ? `: ${tail}` : ''}`, 502));
      });
    });
  }
  #write(message) { if (!this.gone && this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); }
  call(method, params) {
    return new Promise((resolve, reject) => {
      if (this.gone) return reject(new BridgeError('The agent process has ended', 502));
      const id = ++this.#seq;
      this.#pending.set(id, { resolve, reject });
      this.#write({ id, method, params });
    });
  }
  notify(method, params) { this.#write({ method, params }); }
  /** Ends stdin, then SIGTERM and SIGKILL if the process does not leave by itself. */
  async close(graceMs) {
    if (this.gone) return;
    const wait = ms => Promise.race([this.ended, new Promise(resolve => setTimeout(resolve, ms).unref())]);
    this.child.stdin.end();
    await wait(graceMs);
    if (!this.gone) { this.child.kill('SIGTERM'); await wait(1000); }
    if (!this.gone) { this.child.kill('SIGKILL'); await wait(1000); }
  }
}

/**
 * Runs one agent node over ACP and resolves with its final answer. This is the one function agent graphs call to
 * move work between agents: Love Spot (bridge/love-agents.mjs) per card, and the Workflows bridge runtime per stage
 * transition, passing the previous stage's answer in `inputs` instead of posting it into a chat.
 *
 * @param spec `{ name, command, args?, env?, model?, mode?, instructions?, instructionsInPrompt?, meta? }`: the ACP agent
 *   process to start. `model` is chosen with session/set_config_option (the agent must offer it); `instructions` go
 *   in session/new `_meta.systemPrompt.append` (Elpis, Claude and Antigravity agents read it), or at the head of the
 *   prompt with `instructionsInPrompt` for agents that take no system prompt.
 * @param input `{ task, inputs?: [{ name, answer }] }`: the prompt; `inputs` are final answers of connected nodes.
 * @param options `{ cwd (absolute), signal?, timeoutMs?, graceMs?, onUpdate?(update), onPermission?(request) →
 *   optionId | null, onSession?(sessionId), onSpawn?(child) }`. Every session/update goes to `onUpdate`; a
 *   session/request_permission goes to `onPermission`, and no handler, null or an option the agent did not offer
 *   rejects it. A timeout or `signal` sends session/cancel, answers waiting permission requests `cancelled`, and stops
 *   the process after `graceMs`.
 * @returns `{ sessionId, answer, stopReason }`; rejects with a BridgeError when the node fails, stops for another
 *   reason than end_turn, gives no answer, is cancelled or times out, or its process ends early.
 */
export async function runAcpNode(spec, { task, inputs = [] } = {}, options = {}) {
  const { cwd, signal, timeoutMs = 300000, graceMs = 2000, onUpdate, onPermission, onSession, onSpawn, onControl } = options;
  const name = spec?.name || 'The agent';
  if (typeof spec?.command !== 'string' || !spec.command) throw new BridgeError(`${name} has no ACP command`, 500);
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new BridgeError('Working folder must be absolute');
  const text = handoffText(task, inputs, spec.instructionsInPrompt ? spec.instructions : undefined);
  if (signal?.aborted) throw new BridgeError(`${name} was cancelled`, 409);

  const answer = new Answer(), waiting = new Set();
  const tools = new Set(), idle = new Set();
  const wake = () => { for (const resolve of idle) resolve(); idle.clear(); };
  let sessionId = null, prompting = false, stopped = null, rejectStop;
  const stopping = new Promise((_, reject) => { rejectStop = reject; });
  stopping.catch(() => {});
  const node = new AcpProcess(spec, cwd, {
    onNotification(method, params) {
      if (method !== 'session/update' || !sessionId || params?.sessionId !== sessionId) return;
      const update = params.update;
      if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate) && update.toolCallId) {
        if (['completed', 'failed'].includes(update.status)) tools.delete(update.toolCallId);
        else if (update.sessionUpdate === 'tool_call' || ['pending', 'in_progress'].includes(update.status)) tools.add(update.toolCallId);
        if (!tools.size) wake();
      }
      answer.add(params.update);
      try { onUpdate?.(params.update); } catch {}
    },
    async onRequest(method, params) {
      if (method !== 'session/request_permission') throw Object.assign(new Error(`Elpis does not offer ${method}`), { code: -32601 });
      const offered = Array.isArray(params?.options) ? params.options : [];
      const reject = offered.find(option => option.kind === 'reject_once') ?? offered.find(option => String(option.kind).startsWith('reject'));
      const refuse = { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
      if (stopped) return { outcome: { outcome: 'cancelled' } };
      // Workflow subagents share the automatic policy. Ordinary callers accept only their own session.
      if (params?.sessionId !== sessionId && !spec.meta?.elpis?.workflow) return refuse;
      let cancel;
      const cancelled = new Promise(resolve => { cancel = () => resolve(CANCELLED); });
      waiting.add(cancel);
      try {
        const chosen = await Promise.race([Promise.resolve().then(() => onPermission?.(params)).catch(() => null), cancelled]);
        if (chosen === CANCELLED || stopped) return { outcome: { outcome: 'cancelled' } };
        const option = offered.find(item => item.optionId === chosen);
        return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : refuse;
      } finally { waiting.delete(cancel); }
    },
  });
  onSpawn?.(node.child);
  const stop = error => {
    if (stopped) return;
    stopped = error;
    wake();
    for (const cancel of waiting) cancel();
    if (sessionId && prompting) node.notify('session/cancel', { sessionId });
    rejectStop(error);
  };
  const timer = setTimeout(() => stop(new BridgeError(`${name} timed out; open its chat to inspect the result`, 504)), timeoutMs);
  const abort = () => stop(new BridgeError(`${name} was cancelled`, 409));
  signal?.addEventListener('abort', abort, { once: true });

  const work = (async () => {
    const init = await node.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'elpis', title: 'Elpis', version: '0.1.0' } });
    if (init?.protocolVersion !== 1) throw new BridgeError(`${name} speaks ACP version ${init?.protocolVersion ?? 'unknown'}; Elpis speaks version 1`, 502);
    const meta = { ...spec.meta, ...(spec.instructions?.trim() && !spec.instructionsInPrompt ? { systemPrompt: { append: spec.instructions.trim() } } : {}) };
    const session = await node.call('session/new', { cwd, mcpServers: [], ...(Object.keys(meta).length ? { _meta: meta } : {}) });
    if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new BridgeError(`${name} did not start a session`, 502);
    sessionId = session.sessionId;
    onSession?.(sessionId);
    let configOptions = session.configOptions ?? [];
    if (spec.model) {
      const option = configOptions.find(item => item.id === 'model');
      if (!option) throw new BridgeError(`${name} does not offer a model choice over ACP`, 400);
      const values = (option.options ?? []).flatMap(item => Array.isArray(item.options) ? item.options : [item]).map(item => item.value);
      if (!values.includes(spec.model)) throw new BridgeError(`${name} does not offer the model ${spec.model}`, 400);
      const changed = await node.call('session/set_config_option', { sessionId, configId: 'model', value: spec.model });
      configOptions = changed?.configOptions ?? configOptions;
    }
    if (spec.mode) await node.call('session/set_mode', { sessionId, modeId: spec.mode });
    // Elpis takes effort in its scoped workflow policy. Other ACP agents advertise it after model selection.
    if (spec.reasoningEffort && !spec.elpis) {
      const option = configOptions.find(item => item.id === 'effort');
      const values = (option?.options ?? []).flatMap(item => Array.isArray(item.options) ? item.options : [item]).map(item => item.value);
      if (!values.includes(spec.reasoningEffort)) throw new BridgeError(`${name} does not offer the effort ${spec.reasoningEffort} for this model`, 400);
      await node.call('session/set_config_option', { sessionId, configId: 'effort', value: spec.reasoningEffort });
    }
    if (stopped) throw stopped;
    prompting = true;
    let sending = Promise.resolve();
    onControl?.({ steer(message) {
      const sent = sending.catch(() => {}).then(async () => {
        // An idle notification is a wake-up only: another tool may start in the same transport read.
        while (tools.size && prompting && !stopped && !node.gone) await new Promise(resolve => idle.add(resolve));
        if (stopped || !prompting || node.gone) throw new BridgeError(`${name} is not running`, 409);
        const result = await Promise.race([node.call('_session/steering', { sessionId, prompt: [{ type: 'text', text: message }], _meta: { steering: { idleBehavior: 'promptRequired' } } }), stopping, node.ended.then(error => { throw error; })]);
        if (!['injected', 'queued'].includes(result?.outcome)) throw new BridgeError(`${name} ended before the message could be delivered`, 409);
        return { delivery: result?._meta?.delivery ?? 'currentTurn' };
      });
      sending = sent; return sent;
    } });
    let result;
    try { result = await node.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }); }
    finally { prompting = false; wake(); }
    if (stopped) throw stopped;
    if (result?.stopReason !== 'end_turn') throw new BridgeError(`${name} stopped: ${result?.stopReason ?? 'without a reason'}`, 502);
    const final = answer.text;
    if (typeof final !== 'string' || !final.trim()) throw new BridgeError(`${name} finished without an answer`, 502);
    if (final.length > MAX_ANSWER) throw new BridgeError(`${name}'s answer is too long to pass to another agent; open its chat`, 413);
    return { sessionId, answer: final, stopReason: result.stopReason };
  })();
  work.catch(() => {});
  try {
    return await Promise.race([work, stopping, node.ended.then(error => { throw error; })]);
  } catch (error) {
    // A stopped node may still say `cancelled` and leave by itself; it gets the grace period to do so.
    if (stopped) { await Promise.race([work.catch(() => {}), node.ended, new Promise(resolve => setTimeout(resolve, graceMs).unref())]); throw stopped; }
    throw error;
  } finally {
    prompting = false; wake();
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    await node.close(stopped ? 0 : graceMs);
  }
}
