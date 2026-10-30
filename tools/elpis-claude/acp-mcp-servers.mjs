import { validateHeaderName, validateHeaderValue } from "node:http";

const PREFIX = "mcp_servers.";
const ownObject = value => value && typeof value === "object" && !Array.isArray(value);
const serverLabel = name => `MCP server "${name}"`;
const fail = (name, reason) => { throw new Error(`${serverLabel(name)} ${reason}`); };

/** Thread-start overrides sent by the desktop. Disabled entries are retained so a per-thread
 * opt-out cannot fall back to the user's globally enabled server. */
export function appMcpConfig(config) {
  const entries = Object.entries(config ?? {}).filter(([key, server]) =>
    key.startsWith(PREFIX) && key !== `${PREFIX}elpis-agents` && ownObject(server));
  return entries.length ? Object.fromEntries(entries) : null;
}

/** Resolve persisted names against current effective settings; a removed/disabled server stays off. */
export function restoredMcpOverrides(read, saved) {
  const available = read?.config?.mcp_servers && typeof read.config.mcp_servers === "object" ? read.config.mcp_servers : {};
  const config = {}, warnings = [];
  for (const name of saved) {
    if (name === "elpis-agents" || name === "elpis_browser") continue;
    const server = available[name];
    if (!server || typeof server !== "object" || Array.isArray(server) || !(typeof server.command === "string" || typeof server.url === "string")) {
      warnings.push(`MCP server "${name}" is no longer configured and stays off in this chat.`);
    } else if (server.enabled === false) {
      warnings.push(`MCP server "${name}" is disabled in MCP settings and stays off in this chat.`);
    } else config[`mcp_servers.${name}`] = { ...server, enabled: true };
  }
  return { config: Object.keys(config).length ? config : null, warnings };
}

/** Refresh a cached per-thread MCP map on resume; missing metadata leaves legacy/live mappings intact. */
export async function restoreMcpSession(threadId, { selections, cache, readConfig, onWarning = () => {} }) {
  let saved, selectionUnreadable = false;
  try { saved = selections.get(threadId); }
  catch { saved = []; selectionUnreadable = true; }
  if (saved === undefined) return [];
  const internal = Object.fromEntries(Object.entries(cache.get(threadId) ?? {})
    .filter(([key]) => key === `${PREFIX}elpis_browser`));
  if (selectionUnreadable) {
    const warning = "Saved MCP choices for this chat could not be read; user MCP servers stay off.";
    cache.set(threadId, internal);
    onWarning(warning);
    return [warning];
  }
  try {
    const restored = restoredMcpOverrides(await readConfig(), saved);
    cache.set(threadId, { ...internal, ...(restored.config ?? {}) });
    if (restored.warnings.length) onWarning(restored.warnings.join(" "));
    return restored.warnings;
  } catch {
    const warning = "MCP servers in this chat could not be checked and stay off for this session.";
    cache.set(threadId, internal);
    onWarning(warning);
    return [warning];
  }
}

/** Sanitize MCP transports before the ACP bridge writes a thread-start request to its debug log. */
export function redactMcpConfigForLog(line) {
  try {
    const message = JSON.parse(line);
    const config = message?.params?.config;
    if (!ownObject(config)) return line;
    for (const [key, server] of Object.entries(config)) {
      if (!key.startsWith(PREFIX) || !ownObject(server)) continue;
      if (typeof server.command === "string") server.command = "[redacted:mcp-command]";
      if (Array.isArray(server.args)) server.args = server.args.map(() => "[redacted:mcp-argument]");
      for (const field of ["env", "http_headers"]) {
        if (ownObject(server[field])) server[field] = Object.fromEntries(Object.keys(server[field]).map(name => [name, "[redacted:mcp-value]"]));
      }
      if (server.url) {
        try {
          const url = new URL(server.url);
          server.url = url.origin;
        } catch { server.url = "[redacted:mcp-url]"; }
      }
      if (server.bearer_token) server.bearer_token = "[redacted:mcp-value]";
      if (server.oauth) server.oauth = "[redacted:mcp-auth]";
      if (server.http_headers_helper) server.http_headers_helper = "[redacted:mcp-helper]";
    }
    return JSON.stringify(message);
  } catch { return line; }
}

function httpHeaders(server, name, env) {
  const headers = new Map();
  const set = (header, value) => {
    if (typeof header !== "string" || typeof value !== "string") fail(name, "has an invalid HTTP header configuration.");
    try { validateHeaderName(header); validateHeaderValue(header, value); }
    catch { fail(name, "has an invalid HTTP header configuration."); }
    headers.set(header.toLowerCase(), { name: header, value });
  };
  const staticHeaders = server.http_headers ?? {};
  if (!ownObject(staticHeaders)) fail(name, "has an invalid static HTTP header configuration.");
  for (const [header, value] of Object.entries(staticHeaders)) set(header, value);

  const environmentHeaders = server.env_http_headers ?? {};
  if (!ownObject(environmentHeaders)) fail(name, "has an invalid environment HTTP header configuration.");
  for (const [header, variable] of Object.entries(environmentHeaders)) {
    if (typeof variable !== "string" || !variable) fail(name, `has an invalid environment variable name for HTTP header "${header}".`);
    const value = env[variable];
    if (typeof value !== "string" || !value.trim()) fail(name, `requires environment variable "${variable}" for HTTP header "${header}", but it is not set.`);
    set(header, value);
  }

  if (server.bearer_token_env_var !== undefined && server.bearer_token_env_var !== null) {
    const variable = server.bearer_token_env_var;
    if (typeof variable !== "string" || !variable) fail(name, "has an invalid bearer-token environment variable name.");
    const token = env[variable];
    if (typeof token !== "string" || !token.trim()) fail(name, `requires bearer-token environment variable "${variable}", but it is not set.`);
    set("Authorization", `Bearer ${token}`);
  }

  if (server.http_headers_helper) fail(name, "uses a local HTTP headers helper that this provider cannot run.");
  const auth = server.auth ?? "oauth";
  if (auth === "ema_auth") fail(name, "requires enterprise authentication that this provider cannot provide.");
  if (auth !== "oauth" && auth !== "chatgpt") fail(name, "uses an unsupported HTTP authentication mode.");
  if (!headers.has("authorization")) {
    if (auth === "chatgpt") fail(name, "requires ChatGPT session authentication that this provider cannot provide.");
  }
  return [...headers.values()];
}

/** Convert configured app servers to ACP's stable session schema. Environment-backed HTTP
 * headers are resolved here, in memory, and are never written to the thread config or logs. */
export function acpServersFrom(config, threadId, env = process.env) {
  const servers = [];
  for (const [key, server] of Object.entries(config ?? {})) {
    if (!key.startsWith(PREFIX) || key === `${PREFIX}elpis-agents` || !ownObject(server) || server.enabled === false) continue;
    const name = key.slice(PREFIX.length);
    if (typeof server.url === "string") {
      if (typeof server.command === "string") fail(name, "has both HTTP and stdio transports configured.");
      servers.push({ type: "http", name, url: server.url, headers: httpHeaders(server, name, env) });
      continue;
    }
    if (typeof server.command === "string") {
      servers.push({ name, command: server.command, args: Array.isArray(server.args) ? server.args.map(String) : [],
        env: [...Object.entries(server.env ?? {}).map(([envName, value]) => ({ name: envName, value: String(value) })), { name: "ELPIS_THREAD_ID", value: threadId }] });
      continue;
    }
    fail(name, "has no supported transport configured.");
  }
  return servers;
}
