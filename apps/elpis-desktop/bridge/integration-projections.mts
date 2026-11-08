import { publicUrl } from "./provider-projections.mts";
import { string, number } from "./projection-values.mts";
import type { RecordValue, ConfigRead } from "./feature-types.mts";
/** Lifecycle hooks as Elpis discovered them, with the user-layer version their state writes need. */
export function hooksSnapshot(
  list:
    | {
        data?: {
          hooks?: RecordValue[];
          warnings?: unknown[];
          errors?: {
            path?: unknown;
            message?: unknown;
          }[];
        }[];
      }
    | null
    | undefined,
  read: ConfigRead,
) {
  const userLayer = read?.layers?.find(layer => layer.name?.type === "user" && !layer.name.profile);
  const seen = new Set(),
    hooks = [],
    warnings: string[] = [],
    errors = [];
  for (const entry of Array.isArray(list?.data) ? list.data : []) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (typeof hook?.key !== "string" || seen.has(hook.key)) continue;
      seen.add(hook.key);
      hooks.push({
        key: hook.key,
        event: string(hook.eventName),
        handler: string(hook.handlerType),
        command: string(hook.command),
        server: string(hook.server),
        tool: string(hook.tool),
        matcher: string(hook.matcher),
        timeoutSec: number(hook.timeoutSec),
        statusMessage: string(hook.statusMessage),
        source: string(hook.source),
        sourcePath: string(hook.sourcePath),
        pluginId: string(hook.pluginId),
        enabled: hook.enabled === true,
        managed: hook.isManaged === true,
        trust: string(hook.trustStatus),
        currentHash: string(hook.currentHash),
      });
    }
    for (const warning of Array.isArray(entry?.warnings) ? entry.warnings : [])
      if (typeof warning === "string" && !warnings.includes(warning)) warnings.push(warning);
    for (const error of Array.isArray(entry?.errors) ? entry.errors : [])
      if (typeof error?.message === "string") errors.push({ path: string(error.path), message: error.message });
  }
  return {
    version: string(userLayer?.version),
    write: { available: typeof userLayer?.version === "string" },
    hooks,
    warnings,
    errors,
  };
}
export const CREDENTIAL = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i;
/** MCP servers from the effective config: names, transport and credential presence only. */
export function mcpSnapshot(read: ConfigRead, env = process.env) {
  const servers = read?.config?.mcp_servers ?? {};
  const userLayer = read?.layers?.find(layer => layer.name?.type === "user" && !layer.name.profile);
  return {
    version: string(userLayer?.version),
    configPath: string(userLayer?.name?.file),
    write: { available: typeof userLayer?.version === "string" },
    servers: Object.entries(servers)
      .filter(([, def]) => def && typeof def === "object")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, def]) => ({
        name,
        enabled: def.enabled !== false,
        transport: typeof def.url === "string" ? "http" : "stdio",
        command: typeof def.command === "string" ? def.command : null,
        url: typeof def.url === "string" ? publicUrl(def.url) : null,
        credentials: [
          ...Object.entries(def.env ?? {})
            .filter(([key]) => CREDENTIAL.test(key))
            .map(([key, value]) => ({ name: key, source: "config", set: value !== "" && value != null })),
          ...(Array.isArray(def.env_vars) ? def.env_vars : [])
            .filter(key => typeof key === "string" && CREDENTIAL.test(key))
            .map(key => ({ name: key, source: "environment", set: Boolean(env[key]) })),
          ...(typeof def.bearer_token_env_var === "string"
            ? [{ name: def.bearer_token_env_var, source: "environment", set: Boolean(env[def.bearer_token_env_var]) }]
            : []),
        ],
        ...(name === "whispertype"
          ? {
              whispertype: {
                backend: def.env?.WHISPERTYPE_BACKEND ?? null,
                model: string(def.env?.WHISPERTYPE_CLOUD_MODEL),
                ...(def.env?.WHISPERTYPE_EVERY_CHAT === "1" ? { everyChat: true } : {}),
                ...(def.env?.ELPIS_DICTATION_EXPLICIT === "1" ? { explicit: true } : {}),
              },
            }
          : {}),
      })),
  };
}
