#!/usr/bin/env node
// Runs one task on an Anthropic Managed Agent and prints the agent's text as it streams.
//   node managed-agent.mjs --setup [--agent ID]   (once: applies managed-agent-system.md, xhigh effort and the tools)
//   node managed-agent.mjs [--agent ID] [--environment ID] [--budget-usd N] [--title T] (--message TEXT | --message-file PATH)
// The control-plane key comes from ANTHROPIC_API_KEY or ~/.config/elpis/anthropic-credits.env and is never printed.
// The agent's tools run wherever the environment's worker runs (managed-worker.sh for this machine).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

export const DEFAULTS = { agent: 'agent_01NFcJcyAz14txaLSkbj5pY1', environment: 'env_012gguPeTQSEmhpbjVNvkmjp', budgetUsd: 10, title: 'Elpis task' };
// The Console workspace of Masih's promotional credits (as in ~/.elpis-next/config.toml's anthropic-credits provider).
const WORKSPACE = process.env.ANTHROPIC_WORKSPACE_ID || 'wrkspc_01GCfeEpVbk1SoLG7a6koPdF';
const KEY_FILE = path.join(os.homedir(), '.config/elpis/anthropic-credits.env');

/** The API key, from the environment or the private key file; null when neither has one. */
export function apiKey(env = process.env, file = KEY_FILE) {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  try {
    const line = fs.readFileSync(file, 'utf8').split('\n').find(row => row.startsWith('ANTHROPIC_API_KEY='));
    return line?.slice('ANTHROPIC_API_KEY='.length).trim() || null;
  } catch { return null; }
}

export function parseArgs(argv) {
  const args = { ...DEFAULTS, message: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === '--agent') args.agent = value;
    else if (flag === '--environment') args.environment = value;
    else if (flag === '--budget-usd') args.budgetUsd = Number(value);
    else if (flag === '--title') args.title = value;
    else if (flag === '--message') args.message = value;
    else if (flag === '--message-file') args.message = fs.readFileSync(value, 'utf8');
    else throw Error(`unknown argument ${flag}`);
    i++;
  }
  if (!args.message?.trim()) throw Error('give the task with --message or --message-file');
  if (!(args.budgetUsd > 0)) throw Error('--budget-usd must be above 0');
  return args;
}

const said = event => (event.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
const terminal = event => event.type === 'session.status_terminated'
  || (event.type === 'session.status_idle' && event.stop_reason?.type !== 'requires_action');

/** Streams one session from the kickoff to its end. Opens the stream before sending, survives dropped streams by
 * reading the event history and skipping events already handled, answers paused tool calls with a denial (nobody is
 * watching), and returns how the session stopped. */
export async function runSession(client, sessionId, message, out = process.stdout, log = process.stderr) {
  const seen = new Set();
  let sent = false, started = false;
  const handle = async event => {
    if (event.type === 'session.status_running') started = true;
    else if (event.type === 'agent.message') out.write(said(event));
    else if (event.type === 'agent.tool_use' || event.type === 'agent.mcp_tool_use') {
      log.write(`\n· ${event.name}\n`);
      if (event.evaluated_permission === 'ask') await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.tool_confirmation', tool_use_id: event.id, result: 'deny' }] });
    } else if (event.type === 'agent.custom_tool_use') {
      await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.custom_tool_result', custom_tool_use_id: event.id, content: [{ type: 'text', text: 'This client provides no custom tools.' }] }] });
    } else if (event.type === 'session.error') log.write(`\n[session error] ${event.error?.message ?? JSON.stringify(event.error ?? event)}\n`);
  };
  for (let attempt = 0; ; attempt++) {
    const stream = await client.beta.sessions.events.stream(sessionId);
    if (attempt > 0) for await (const event of client.beta.sessions.events.list(sessionId)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id); await handle(event);
      if (started && terminal(event)) return event.stop_reason?.type ?? 'terminated';
    }
    if (!sent) { await client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.message', content: [{ type: 'text', text: message }] }] }); sent = true; }
    try {
      for await (const event of stream) {
        if (!seen.has(event.id)) { seen.add(event.id); await handle(event); }
        if (started && terminal(event)) return event.stop_reason?.type ?? 'terminated';
      }
    } catch (error) {
      if (attempt >= 4 || error instanceof Anthropic.APIError) throw error;
      log.write(`\n[stream dropped: ${error.message}; reconnecting]\n`);
    }
  }
}

/** The agent's configuration, versioned by the API: the brief in managed-agent-system.md (no persona), extra-high
 * effort, and the built-in tools with no approval prompts (they run in managed-worker.sh's sandbox); the web tools
 * stay off because they would run on Anthropic's servers, outside that sandbox. */
export async function setupAgent(client, agentId, system) {
  const agent = await client.beta.agents.retrieve(agentId);
  const model = typeof agent.model === 'string' ? agent.model : agent.model?.id;
  return client.beta.agents.update(agentId, {
    version: agent.version, system,
    model: { id: model, effort: 'xhigh' },
    tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
      configs: [{ name: 'web_fetch', enabled: false }, { name: 'web_search', enabled: false }] }],
  });
}

async function main() {
  const argv = process.argv.slice(2), setup = argv[0] === '--setup';
  const key = apiKey();
  if (!key) { console.error(`No Anthropic API key: set ANTHROPIC_API_KEY or write ${KEY_FILE} (mode 600).`); return 2; }
  const client = new Anthropic({ apiKey: key });
  if (setup) {
    const agentId = argv[1] === '--agent' ? argv[2] : DEFAULTS.agent;
    const system = fs.readFileSync(new URL('./managed-agent-system.md', import.meta.url), 'utf8');
    const agent = await setupAgent(client, agentId, system);
    console.error(`agent ${agent.id} is now version ${agent.version} (${typeof agent.model === 'string' ? agent.model : agent.model?.id}, xhigh)`);
    return 0;
  }
  const args = parseArgs(argv);
  const session = await client.beta.sessions.create({
    agent: args.agent, environment_id: args.environment, title: args.title,
    budget: { type: 'limit', max_list_cost: { amount: String(Math.round(args.budgetUsd * 100)), currency: 'USD' } },
  });
  console.error(`session ${session.id} (budget $${args.budgetUsd}); trace: https://platform.claude.com/workspaces/${WORKSPACE}/sessions/${session.id}`);
  process.once('SIGINT', () => {
    console.error('\ninterrupting the session');
    client.beta.sessions.events.send(session.id, { events: [{ type: 'user.interrupt' }] }).finally(() => process.exit(130));
  });
  const stop = await runSession(client, session.id, args.message);
  console.error(`\nsession stopped: ${stop}`);
  return stop === 'end_turn' ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().then(code => { process.exitCode = code; }, error => {
    const detail = error instanceof Anthropic.APIError ? `${error.status ?? ''} ${error.error?.error?.message ?? error.message}` : error.message;
    console.error(`managed-agent: ${detail.trim()}`);
    process.exitCode = 1;
  });
}
