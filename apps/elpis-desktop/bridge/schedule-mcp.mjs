// The Automations tools a chat gets (6 Nov, Masih: "they should be able to write a single prompt and we should implement
// it for them"): one sentence such as "every weekday at 9, check the CI" becomes a task on the Automations page. A stdio
// MCP server, attached per chat like bridge/browser-mcp.mjs; it reaches only /api/automations, with the key the app gives
// it (bridge/server.mjs automationAccess).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// The rule help is DeepSeek Harness's (packages/schedule/tool-schedule/src/index.ts RRULE_HELP), for the subset Elpis reads.
const RULE = {
  type: 'string',
  description: 'When it runs: one DTSTART line, a newline, and one RRULE line (RFC 5545). DTSTART carries TZID with an IANA time zone '
    + `(this computer's is ${Intl.DateTimeFormat().resolvedOptions().timeZone}) or ends in Z for UTC. A TZID rule keeps local clock time across `
    + 'daylight-saving changes; skipped local times are skipped, and repeated ones occur once, at the earlier instant. A one-time run is '
    + 'RRULE:FREQ=DAILY;COUNT=1. FREQ is MINUTELY, HOURLY, DAILY, WEEKLY, MONTHLY or YEARLY. MINUTELY and HOURLY take no BY parts, so pick clock '
    + 'times with DAILY or WEEKLY plus BYHOUR and BYMINUTE. Example: "DTSTART;TZID=Asia/Tehran:20261109T090000\\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR".',
};
export const tools = [
  { name: 'automation_create', description: 'Schedule a prompt that Elpis sends later or repeatedly. Only when the user explicitly asks for a reminder, a recurring check or a scheduled task. '
      + 'target "this_chat" sends it into the current chat (reminders, follow-ups); "one_chat" makes one new chat on the first run and reuses it; "new_chat" starts a new chat every run (independent reports).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['title', 'prompt', 'rule', 'target'], properties: {
      title: { type: 'string', description: 'A short name, at most 120 characters.' },
      prompt: { type: 'string', description: 'The message sent each time, written as the user would write it.' },
      rule: RULE,
      target: { type: 'string', enum: ['this_chat', 'one_chat', 'new_chat'] },
      cwd: { type: 'string', description: 'Absolute project folder for new chats; omit for the current chat\'s folder or none.' },
    } } },
  { name: 'automation_list', description: 'List the scheduled automations with their id, rule, status and next run.', inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'automation_update', description: 'Change, pause, resume or delete an automation, only at the user\'s explicit request. action "update" takes any of title, prompt, rule; "pause", "resume" and "delete" take only id.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id', 'action'], properties: {
      id: { type: 'string' }, action: { type: 'string', enum: ['update', 'pause', 'resume', 'delete'] }, title: { type: 'string' }, prompt: { type: 'string' }, rule: RULE,
    } } },
];

export function scheduleMcpConfig(access, node = process.env.ELPIS_NODE_BIN || 'node') {
  return { 'mcp_servers.elpis_automations': { command: node, args: [fileURLToPath(import.meta.url)], env: { ELPIS_AUTOMATIONS_URL: access.url, ELPIS_AUTOMATIONS_KEY: access.key } } };
}

/** The task as the model reads it: what, when, and where it stands. */
const brief = task => ({ id: task.id, title: task.title, prompt: task.prompt, when: task.description, status: task.status,
  next: task.nextRunAt ? new Date(task.nextRunAt).toString() : null, runsIn: task.target === 'reuse' ? 'one chat' : 'a new chat each run' });

/** Runs one tool call against the app; `request(path, body?)` posts (or gets, without a body) and returns its JSON. */
export async function callTool(name, args, threadId, request) {
  if (name === 'automation_list') return { automations: (await request('/api/automations')).data.map(brief) };
  if (name === 'automation_create') {
    const { target, ...rest } = args ?? {};
    if (!['this_chat', 'one_chat', 'new_chat'].includes(target)) throw Error('target must be this_chat, one_chat or new_chat');
    if (target === 'this_chat' && typeof threadId !== 'string') throw Error('This chat cannot be named; use one_chat instead.');
    const task = await request('/api/automations', { ...rest, ...(target === 'this_chat' ? { threadId } : { target: target === 'new_chat' ? 'new' : 'reuse' }) });
    return { created: brief(task), note: 'It is listed on the Automations page, where the user can run, pause, edit or delete it.' };
  }
  if (name === 'automation_update') {
    const { id, action, ...fields } = args ?? {};
    if (typeof id !== 'string') throw Error('id is required');
    const body = action === 'delete' ? { action: 'delete' } : action === 'pause' ? { action: 'update', status: 'paused' } : action === 'resume' ? { action: 'update', status: 'active' }
      : action === 'update' ? { action: 'update', ...fields } : null;
    if (!body) throw Error('action must be update, pause, resume or delete');
    const result = await request(`/api/automations/${encodeURIComponent(id)}`, body);
    return action === 'delete' ? { deleted: id } : { updated: brief(result) };
  }
  throw Error('Unknown automation tool.');
}

export async function handleMcp(message, call) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.method !== 'string') return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid MCP request' } };
  if (message.id === undefined) return null;
  const reply = result => ({ jsonrpc: '2.0', id: message.id, result });
  if (message.method === 'initialize') return reply({ protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'elpis-automations', version: '1.0.0' } });
  if (message.method === 'ping') return reply({});
  if (message.method === 'tools/list') return reply({ tools });
  if (message.method === 'tools/call') {
    try {
      const { name, arguments: args = {} } = message.params || {};
      return reply({ content: [{ type: 'text', text: JSON.stringify(await call(name, args, message.params?._meta)) }] });
    } catch (error) { return reply({ isError: true, content: [{ type: 'text', text: error.message }] }); }
  }
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown MCP method' } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const base = process.env.ELPIS_AUTOMATIONS_URL, key = process.env.ELPIS_AUTOMATIONS_KEY;
  const request = async (route, body) => {
    const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST', headers: { 'x-elpis-automations': key, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Error(value?.error?.message ?? value?.error ?? `Automations answered ${response.status}`);
    return value;
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    void (async () => {
      let message;
      try { if (Buffer.byteLength(line) > 65536) throw Error('Request too large'); message = JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON request' } }) + '\n'); return; }
      const response = await handleMcp(message, (name, args, meta) => callTool(name, args, typeof meta?.threadId === 'string' ? meta.threadId : process.env.ELPIS_THREAD_ID, request));
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    })();
  });
}
