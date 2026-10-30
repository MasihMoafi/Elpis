import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { BridgeError } from './client.mjs';

// Agents use RAG through its MCP server; the app only shows and changes its provider, models and key
// presence through the `rag` CLI, which owns that configuration. WhisperType's settings live in the
// Elpis MCP config and are written by the native config API (client.mjs), not here.
const LOCAL = ['localhost', '127.0.0.1', '::1'];
const PROXIES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/** Background Node children ignore the proxy unless asked; loopback must still bypass it. */
export function childEnv(env = process.env) {
  // A desktop launched from an agent must not reuse that agent's Claude config or session markers.
  const next = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(CLAUDE|AI_AGENT)/.test(key)));
  next.PATH = `${path.join(os.homedir(), '.local/bin')}:${env.PATH ?? ''}`;
  if (!PROXIES.some(key => env[key])) return next;
  next.NODE_USE_ENV_PROXY = '1';
  const bypass = [...new Set([...String(env.NO_PROXY ?? env.no_proxy ?? '').split(',').map(entry => entry.trim()).filter(Boolean), ...LOCAL])].join(',');
  next.NO_PROXY = bypass; next.no_proxy = bypass;
  return next;
}

export function runCli(command, args, { timeout = 30000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 8 * 1024 * 1024, env: childEnv({ ...process.env, ...env }) },
      (error, stdout, stderr) => {
        if (error) return reject(new BridgeError(`${command} failed. Check its local configuration before retrying.`, 502));
        resolve(stdout);
      });
  });
}

const parseJson = text => { try { return JSON.parse(text); } catch { throw new BridgeError('Tool returned unreadable output', 502); } };
const MODEL = /^[a-z0-9._-]+\/[a-z0-9._:-]+$/i;

async function jsonBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new BridgeError('JSON content type required', 415);
  let size = 0; const chunks = [];
  for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new BridgeError('Request is too large', 413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new BridgeError('Invalid JSON'); }
}

export function createTools({ run = runCli, environment = async () => ({}) } = {}) {
  async function rag() {
    const env = await environment();
    const [capabilities, doctor] = await Promise.all([run('rag', ['capabilities', '--json'], { env }).then(parseJson), run('rag', ['doctor', '--json'], { timeout: 60000, env }).then(parseJson)]);
    const stages = (capabilities.stages ?? []).filter(stage => ['embedding', 'reranking', 'generation'].includes(stage.stage)).map(stage => ({
      stage: stage.stage, provider: typeof stage.provider === 'string' ? stage.provider : null, model: typeof stage.model === 'string' ? stage.model : null,
      location: stage.location === 'local' ? 'local' : stage.location === 'api' ? 'api' : null, credential: typeof stage.required_credential === 'string' ? stage.required_credential : null,
    }));
    const keys = (doctor.detected?.api_keys ?? []).filter(key => typeof key === 'string');
    return { stages, keys: { openrouter: keys.includes('openrouter') } };
  }
  return async function handle(request, response, url, json) {
    const route = `${request.method} ${url.pathname}`;
    if (route === 'GET /api/tools/rag') return json(response, 200, await rag());
    if (route === 'POST /api/tools/rag') {
      const { stage, model } = await jsonBody(request);
      const env = await environment();
      if (stage === 'generation') {
        if (typeof model !== 'string' || !MODEL.test(model)) throw new BridgeError('Give an OpenRouter answer model ID such as deepseek/deepseek-v4.1-flash');
        await run('rag', ['config', 'answer', model], { env });
      } else if (stage === 'reranking') {
        if (typeof model !== 'string' || !(['off', 'fastembed'].includes(model) || MODEL.test(model))) throw new BridgeError('Choose Off, Local (FastEmbed) or an OpenRouter reranker ID');
        await run('rag', ['config', 'reranker', model], { timeout: 120000, env });
      } else throw new BridgeError('Only the answer model and reranker can be changed here; change embeddings with `rag setup`, which re-indexes documents');
      return json(response, 200, await rag());
    }
    throw new BridgeError('Unknown tool operation', 404);
  };
}
