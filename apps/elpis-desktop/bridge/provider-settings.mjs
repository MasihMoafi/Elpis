import fs from 'node:fs';
import path from 'node:path';
import { BridgeError, object, text } from './client.mjs';
const reserved = new Set(['openai', 'claude', 'agy', 'antigravity']);

export function privateConfigFile(configPath) {
  try {
    if (!configPath || !path.isAbsolute(configPath)) throw new Error();
    const file = fs.lstatSync(configPath);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid?.()) throw new Error();
    fs.chmodSync(configPath, 0o600);
  } catch { throw new BridgeError('Credential settings require a writable config file owned by the current user, without a symbolic link.', 403); }
}

export function providerSettingsSnapshot(read, requirementsRead, env = process.env) {
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
        auth: { source: subscription ? 'subscription' : command ? 'command' : envKey ? 'environment' : def.experimental_bearer_token ? 'stored' : 'none', keySet: envKey ? Boolean(env[envKey]) : Boolean(def.experimental_bearer_token), envKey },
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
