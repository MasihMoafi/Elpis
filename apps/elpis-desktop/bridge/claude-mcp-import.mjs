import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const strings = value => value && typeof value === 'object' && !Array.isArray(value) && Object.entries(value).every(([key, val]) => key.length > 0 && key.length <= 128 && typeof val === 'string' && val.length <= 8192 && !/[\0\r\n]/.test(val));
const shortString = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value);

// Keep definition values entirely on the bridge. Preview returns only names, transport and availability.
export function parseClaudeMcp(raw, existing) {
  let config;
  try { config = JSON.parse(raw); } catch { throw Error('Could not read Claude Code MCP settings.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))) throw Error('Could not read Claude Code MCP settings.');
  const definitions = Object.create(null), preview = [];
  for (const [name, value] of Object.entries(config.mcpServers ?? {})) {
    if (!namePattern.test(name)) continue;
    const validObject = value && typeof value === 'object' && !Array.isArray(value);
    const type = validObject ? (value.type ?? (value.command ? 'stdio' : 'unsupported')) : 'unsupported';
    let definition;
    if (type === 'stdio' && Object.keys(value).every(k => ['type','command','args','env'].includes(k)) && shortString(value.command) && (value.args === undefined || (Array.isArray(value.args) && value.args.length <= 64 && value.args.every(x => typeof x === 'string' && x.length <= 4096 && !/[\0\r\n]/.test(x)))) && (value.env === undefined || strings(value.env))) {
      definition = { command: value.command, args: value.args ?? [], ...(value.env === undefined ? {} : { env: value.env }) };
    } else if (type === 'http' && Object.keys(value).every(k => ['type','url','headers'].includes(k)) && shortString(value.url) && (value.headers === undefined || strings(value.headers))) {
      try { const url = new URL(value.url); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) definition = {url:value.url, ...(value.headers === undefined ? {} : {http_headers:value.headers})}; } catch {}
    }
    const status = existing.includes(name) ? 'exists' : definition ? 'available' : 'unsupported';
    if (status === 'available') definitions[name] = definition;
    preview.push({name, transport: type === 'stdio' ? 'stdio' : type === 'http' ? 'http' : 'unsupported', status});
  }
  return { preview, definitions };
}

export async function readClaudeMcp(home, existing) {
  let raw;
  try { raw = await fs.readFile(path.join(home, '.claude.json'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return { preview: [], definitions: {}, revision: 'missing' }; throw Error('Could not read Claude Code MCP settings.'); }
  if (Buffer.byteLength(raw) > 10 * 1024 * 1024) throw Error('Claude Code settings are too large to import.');
  return { ...parseClaudeMcp(raw, existing), revision: createHash('sha256').update(raw).digest('hex') };
}
