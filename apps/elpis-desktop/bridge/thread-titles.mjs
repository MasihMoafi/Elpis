import { isAgentRun, agentParentId } from '../lib/agent-runs.mjs';
import { askBackground } from './side-turn.mjs';

// A chat is named when it starts, as the Elpis TUI names it (codex-rs/tui/src/app/thread_title.rs and the trigger in
// tui/src/app/thread_routing.rs): its first user message, in a hidden read-only side turn, saved only while it has no name.
const TITLE_MAX_CHARS = 36, TITLE_MODEL = 'gpt-5.6-luna', PROMPT_MAX_BYTES = 960, TIMEOUT_MS = 30000;
const PROMPT_REQUEST_BEGIN = '## My request for Codex:';
export const TITLE_INSTRUCTIONS = `Generate a concise, single-line task title of at most ${TITLE_MAX_CHARS} characters and under five words where possible. `
  + 'Start with an imperative verb. Capitalize only the first word unless the user\'s language, proper nouns, acronyms, or code terms require otherwise. '
  + 'Preserve ticket references exactly. Write in the user\'s language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.';
const TITLE_SCHEMA = { type: 'object', properties: { title: { type: 'string', minLength: 1, maxLength: TITLE_MAX_CHARS } }, required: ['title'], additionalProperties: false };
// The TUI's temporary thread: no tools, extensions or MCP servers, since the prompt carries untrusted text.
const NO_TOOLS = Object.fromEntries(['features.apps', 'features.code_mode', 'features.code_mode_only', 'features.context_management',
  'features.current_time_reminder', 'features.deferred_executor', 'features.enable_fanout', 'features.goals', 'features.hooks',
  'features.image_generation', 'features.memories', 'features.multi_agent', 'features.multi_agent_v2', 'features.plugins',
  'features.request_permissions_tool', 'features.shell_snapshot', 'features.shell_tool', 'features.standalone_web_search',
  'features.token_budget', 'features.tool_suggest', 'features.unified_exec', 'features.view_image', 'cloud.skills.enabled',
  'skills.include_instructions', 'tools.experimental_request_user_input.enabled', 'tools.update_plan.enabled'].map(key => [key, false]));

/** The request part of a message an IDE wrapped in context (tui/src/ide_context/prompt.rs). */
const request = text => { const at = text.lastIndexOf(PROMPT_REQUEST_BEGIN); return at < 0 ? text : text.slice(at + PROMPT_REQUEST_BEGIN.length).trim(); };
/** The instructions and the user's message, cut to 960 bytes without splitting a character. */
export function titlePrompt(userMessage) {
  const prefix = `${TITLE_INSTRUCTIONS}\n\nUser prompt:\n`;
  let room = PROMPT_MAX_BYTES - Buffer.byteLength(prefix), kept = '';
  for (const character of userMessage.trim()) {
    room -= Buffer.byteLength(character);
    if (room < 0) break;
    kept += character;
  }
  return `${prefix}${kept}`;
}
/** The model's {title}, unquoted, on one line, without trailing punctuation, at most 36 characters; else null. */
function parseTitle(response) {
  if (!response.trimStart().startsWith('{')) return null;
  let answer;
  try { answer = JSON.parse(response); } catch { return null; }
  if (!answer || typeof answer.title !== 'string' || Object.keys(answer).length !== 1) return null;
  const title = answer.title.trim().replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').split(/\s+/).filter(Boolean).join(' ').replace(/[.?!]+$/, '').trimEnd();
  return title ? Array.from(title).slice(0, TITLE_MAX_CHARS).join('') : null;
}

/** Follows the engine's events (`event`), and names a chat Masih started when its first message arrives. */
export function createThreadTitles(client) {
  const pending = new Map();
  async function generate(id, message, ticket) {
    const chat = await client.readThreadMetadata(id);
    if (chat.name?.trim() || isAgentRun(chat) || agentParentId(chat)) return;
    const catalog = await client.models().catch(() => ({ data: [] }));
    const luna = catalog.data?.some(model => model.model === TITLE_MODEL);
    const servers = await client.sideRpc('config/read', { includeLayers: false, ...(chat.cwd ? { cwd: chat.cwd } : {}) }).then(read => read?.config?.mcp_servers ?? {}, () => null);
    if (servers === null) return; // as the TUI, fail closed when the MCP servers to switch off are unknown
    const answer = await askBackground(client, { prompt: titlePrompt(message), schema: TITLE_SCHEMA, cwd: chat.cwd, permissions: ':read-only',
      model: luna ? { model: TITLE_MODEL, provider: 'openai' } : { model: chat.model, provider: chat.modelProvider },
      effort: luna ? 'low' : undefined, timeoutMs: TIMEOUT_MS, failed: 'Elpis could not name the chat', late: 'Elpis did not name the chat in time',
      config: { ...NO_TOOLS, web_search: 'disabled', mcp_servers: Object.fromEntries(Object.keys(servers).map(name => [name, { enabled: false }])) } });
    const title = parseTitle(answer);
    if (!title || ticket.cancelled) return;
    // The chat's own name wins over an automatic one.
    if ((await client.readThreadMetadata(id)).name?.trim() || ticket.cancelled) return;
    await client.renameThread(id, { name: title });
  }
  return {
    /** Returns the title work it started, if any, so a caller may wait for it. */
    event({ method, params } = {}) {
      const id = params?.threadId;
      if (typeof id !== 'string') return;
      if (method === 'thread/name/updated') {
        const ticket = pending.get(id);
        if (ticket) { ticket.cancelled = true; pending.delete(id); }
        return;
      }
      if (method !== 'item/completed' || params.item?.type !== 'userMessage' || pending.has(id)) return;
      const message = (params.item.content ?? []).filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => request(part.text)).join(' ');
      if (!message.trim()) return;
      const ticket = { cancelled: false };
      pending.set(id, ticket);
      return generate(id, message, ticket).catch(() => {}).finally(() => { if (pending.get(id) === ticket) pending.delete(id); });
    },
  };
}
