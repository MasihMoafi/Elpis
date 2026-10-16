import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, object, text } from './client.mjs';
const reserved = new Set(['openai', 'claude', 'agy', 'antigravity']);

/** The engine's built-in key providers, served through its gateway (codex-rs/model-provider-info/src/elpis_gateway.rs,
 * BUILT_IN_GATEWAY_PROVIDERS). They are not in config.toml, so the desktop needs their address and key variable here. */
export const BUILT_IN_KEY_PROVIDERS = {
  anthropic: { name: 'Anthropic Claude', base_url: 'https://api.anthropic.com/v1', env_key: 'ANTHROPIC_API_KEY', wire_api: 'anthropic_messages' },
  'google-gemini': { name: 'Google Gemini', base_url: 'https://generativelanguage.googleapis.com/v1beta', env_key: 'GEMINI_API_KEY', wire_api: 'gemini_generate_content' },
  openrouter: { name: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', env_key: 'OPENROUTER_API_KEY', wire_api: 'chat', http_headers: { 'X-OpenRouter-Title': 'Elpis' } },
};
/** A provider's definition: the user's config first, then the engine's built-in one. */
export const providerDefinition = (read, id) => read?.config?.model_providers?.[id] ?? BUILT_IN_KEY_PROVIDERS[id] ?? null;
/** Whether a key can be pasted for this provider: it reads one from a variable, and no command or subscription signs it in. */
export const acceptsPastedKey = (id, definition) => !reserved.has(id) && typeof definition?.env_key === 'string' && !definition.requires_openai_auth && !definition.auth && !definition.aws && !definition.gateway_oauth;

export function privateConfigFile(configPath) {
  try {
    if (!configPath || !path.isAbsolute(configPath)) throw new Error();
    const file = fs.lstatSync(configPath);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.()) throw new Error();
    fs.chmodSync(configPath, 0o600);
  } catch { throw new BridgeError('Credential settings require a writable config file owned by the current user, without a symbolic link.', 403); }
}

/** The Elpis home: the folder of the user's config.toml. */
export const configHome = read => { const file = read?.layers?.find(layer => layer.name?.type === 'user' && !layer.name.profile)?.name?.file; return typeof file === 'string' && path.isAbsolute(file) ? path.dirname(file) : null; };

export function providerSettingsSnapshot(read, requirementsRead, env = process.env, saved = new Set()) {
  const user = read?.layers?.find(layer => layer.name?.type === 'user' && !layer.name.profile);
  const managed = requirementsRead?.requirements;
  const available = typeof user?.version === 'string' && requirementsRead !== null && !managed?.modelProvider;
  return {
    version: user?.version ?? null, configPath: user?.name?.file ?? null,
    write: { available, reason: requirementsRead === null ? 'Provider policy is unavailable; update Elpis before changing providers.' : managed?.modelProvider ? 'Your organization controls the model provider.' : typeof user?.version !== 'string' ? 'A writable user configuration is unavailable.' : null },
    managed: { modelProvider: managed?.modelProvider ?? null },
    application: {
      scope: 'newConversations',
      message: 'Saved for new conversations and agents. Existing conversations keep their current provider settings.',
      credentialClearMessage: 'Clearing removes the saved key and environment variable reference for new conversations. It does not revoke authentication in existing conversations or ongoing requests. Start a new conversation to use updated credentials.',
    },
    providers: Object.entries(read?.config?.model_providers ?? {}).filter(([, def]) => def && typeof def === 'object').sort(([a], [b]) => a.localeCompare(b)).map(([id, def]) => {
      const command = Boolean(def.auth || def.aws || def.gateway_oauth || Object.keys(def.http_headers ?? {}).some(key => key.toLowerCase() === 'authorization') || Object.keys(def.env_http_headers ?? {}).some(key => key.toLowerCase() === 'authorization'));
      const subscription = reserved.has(id) || def.requires_openai_auth === true;
      const envKey = typeof def.env_key === 'string' ? def.env_key : null;
      let baseUrl = null; try { const url = new URL(def.base_url); baseUrl = `${url.origin}${url.pathname}`.replace(/\/$/, ''); } catch {}
      return { id, name: typeof def.name === 'string' ? def.name : id, baseUrl,
        wireApi: typeof def.wire_api === 'string' ? def.wire_api : 'responses', editable: available && !subscription && !command && !managed?.modelProviders?.[id],
        auth: { source: subscription ? 'subscription' : command ? 'command' : envKey && saved.has(id) ? 'saved' : envKey ? 'environment' : def.experimental_bearer_token ? 'stored' : 'none',
          keySet: envKey ? saved.has(id) || Boolean(env[envKey]) : Boolean(def.experimental_bearer_token), envKey,
          // A key can be pasted for a provider that reads one from a variable, as the terminal's /provider does.
          acceptsKey: available && !subscription && !command && Boolean(envKey) },
      };
    }),
  };
}

export function providerEdits(input, current) {
  object(input, ['version', 'id', 'name', 'baseUrl', 'credential']);
  text(input.version, 'provider settings version', 200);
  if (typeof input.id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(input.id) || reserved.has(input.id)) throw new BridgeError('Choose a custom provider ID using lowercase letters, numbers, - or _');
  const name = text(input.name, 'provider name', 200).trim();
  let baseUrl;
  try {
    const url = new URL(text(input.baseUrl, 'provider URL', 4096));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error();
    baseUrl = url.href.replace(/\/$/, '');
  } catch { throw new BridgeError('Use HTTPS for hosted providers or HTTP for localhost, without URL credentials, query parameters, or fragments'); }
  object(input.credential, ['action', 'value']);
  if (!['preserve', 'replace', 'clear'].includes(input.credential.action)) throw new BridgeError('Choose whether to preserve, replace, or clear the provider credential');
  const value = input.credential.value;
  if (input.credential.action === 'replace' && (typeof value !== 'string' || value.length > 8192 || /[\r\n\0]/.test(value))) throw new BridgeError('Invalid provider credential');
  if (input.credential.action !== 'replace' && value !== undefined) throw new BridgeError('Only replacing a credential accepts a value');
  if (current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
  if (!current.write.available) throw new BridgeError(current.write.reason, 403);
  const existing = current.providers.find(provider => provider.id === input.id);
  if (existing && !existing.editable) throw new BridgeError('This provider is controlled by another authentication source or organization policy', 403);
  const prefix = `model_providers.${input.id}`;
  const edits = Object.entries({ name, base_url: baseUrl, wire_api: 'responses', requires_openai_auth: false }).map(([key, value]) => ({ keyPath: `${prefix}.${key}`, value, mergeStrategy: 'replace' }));
  const replace = input.credential.action === 'replace' && value.trim() && !/^[*•●]+$/.test(value.trim());
  if (replace || input.credential.action === 'clear') edits.push(
    { keyPath: `${prefix}.experimental_bearer_token`, value: replace ? value : null, mergeStrategy: 'replace' },
    { keyPath: `${prefix}.env_key`, value: null, mergeStrategy: 'replace' },
  );
  return edits;
}
