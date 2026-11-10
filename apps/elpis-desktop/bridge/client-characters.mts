import fs from 'node:fs';
import path from 'node:path';
import { internal_rpc } from './client-rpc.mts';
import { BUILT_IN_KEY_PROVIDERS, configHome } from './provider-settings.mts';
import { gatewayRouted } from './provider-models.mts';
import { savedProviderKey } from './provider-keys.mts';
import { BridgeError } from './validate.mts';
import type { PortraitConnection } from './character-portraits.mts';
import type { DesktopClient } from './client.mts';
import type { ClientState } from './client-state.mts';

/** Resolve each current connection privately, respecting the same managed provider policy as the model picker. */
export async function impl_characterConnections(this: DesktopClient, state: ClientState): Promise<PortraitConnection[]> {
  const [read, policy] = await Promise.all([
    internal_rpc(this, state, 'config/read', { includeLayers: true }),
    internal_rpc(this, state, 'configRequirements/read', {}).catch(() => null),
  ]);
  if (policy === null) throw new BridgeError('Connection policy could not be read. Reconnect before creating a character.', 503);
  const home = configHome(read), allowed = policy.requirements?.modelProvider;
  const connections: PortraitConnection[] = [];
  const account = await internal_rpc(this, state, 'account/read', { refreshToken: false }).catch(() => null);
  // The native runtime owns subscription credentials, refresh and its image extension. Never read its tokens here.
  if ((!allowed || allowed === 'openai') && (account?.account?.type === 'chatgpt' || account?.account?.type === 'apiKey' || (home && fs.existsSync(path.join(home, 'auth.json'))))) {
    const catalog = await this.models({ provider: 'openai' }).catch(() => null);
    const current = typeof read.config?.model === 'string' ? read.config.model : '';
    const model = catalog?.data.find(item => item.model === current)?.model ?? catalog?.data[0]?.model;
    if (model) connections.push({ id: 'openai', name: 'OpenAI sign-in', definition: {}, nativeModel: model });
  }
  const definitions: Record<string, Record<string, unknown>> = { ...BUILT_IN_KEY_PROVIDERS, ...read.config?.model_providers, ...policy.requirements?.modelProviders };
  // An inherited OpenAI API key is a separate usable image route even without a subscription login file.
  if (!definitions.openai && process.env.OPENAI_API_KEY) definitions.openai = { name: 'OpenAI API', base_url: 'https://api.openai.com/v1', env_key: 'OPENAI_API_KEY', wire_api: 'responses' };
  for (const [id, configured] of Object.entries(definitions)) {
    if (allowed && allowed !== id) continue;
    if (connections.some(connection => connection.id === id)) continue;
    const definition = gatewayRouted(configured) && BUILT_IN_KEY_PROVIDERS[id] ? BUILT_IN_KEY_PROVIDERS[id]! : configured;
    if (!['responses', 'chat', 'gemini_generate_content', undefined].includes(definition.wire_api as string | undefined)) continue;
    const key = savedProviderKey(home, id);
    const needsKey = typeof definition.env_key === 'string';
    if (needsKey && !key && !process.env[definition.env_key as string]) continue;
    connections.push({ id, name: typeof definition.name === 'string' ? definition.name : id, definition, savedKey: key });
  }
  return connections;
}
