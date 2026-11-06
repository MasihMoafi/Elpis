import { BUILT_IN_KEY_PROVIDERS, configHome, providerDefinition } from './provider-settings.mjs';
import { BridgeError, object, text } from './validate.mts';
import fs from 'node:fs';
import path from 'node:path';
import { providerModels } from './provider-models.mts';
import { savedProviderKey } from './provider-keys.mjs';
import { subscriptionModels } from "./subscription-models.mts";
import { internal_rpc } from './client-connection.mjs';

/** @typedef {{ cursor?: unknown, limit?: unknown, provider?: unknown, inputModality?: unknown, outputModality?: unknown, refresh?: unknown }} ModelOptions */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {unknown} [input] */
export async function impl_models(clientState, input = {}) {
    const options = /** @type {ModelOptions} */ (object(input, ['cursor', 'limit', 'provider', 'inputModality', 'outputModality', 'refresh']));
    if (options.refresh !== undefined && typeof options.refresh !== 'boolean') throw new BridgeError('refresh must be true or false');
    const refresh = options.refresh === true;
    if (options.inputModality !== undefined && (options.inputModality !== 'audio' || !options.provider)) throw new BridgeError('Choose OpenRouter audio models');
    if (options.outputModality !== undefined && (typeof options.outputModality !== 'string' || !['rerank', 'speech', 'transcription'].includes(options.outputModality) || !options.provider || options.inputModality !== undefined)) throw new BridgeError('Choose OpenRouter output models');
    if (options.provider !== undefined) {
      const provider = text(options.provider, 'configured connection', 64);
      if (!/^[a-z][a-z0-9_-]*$/.test(provider)) throw new BridgeError('Choose an existing configured connection');
      const [read, policy] = await Promise.all([
        internal_rpc.call(this, clientState, 'config/read', { includeLayers: true }),
        internal_rpc.call(this, clientState, 'configRequirements/read', {}).catch(() => null),
      ]);
      if (policy === null) throw new BridgeError('Connection policy could not be read. Try again after reconnecting.', 503);
      const managed = policy.requirements;
      if (managed?.modelProvider && managed.modelProvider !== provider) throw new BridgeError('This connection is restricted by your organization', 403);
      if (options.inputModality || options.outputModality) {
        let host; try { const url = new URL(providerDefinition(read, provider)?.base_url); host = url.protocol === 'https:' && url.hostname === 'openrouter.ai'; } catch { host = false; }
        if (!host) throw new BridgeError('This connection does not provide OpenRouter audio models.');
      }
      // config/read reflects current defaults; model/list retains the engine's startup
      // catalog. An explicit API connection always lists its own endpoint.
      // A connection the engine signs in to itself (ChatGPT, the Anthropic credits) but that is not the default: the engine lists
      // its models (subscription-models.mjs). 1 Nov: with ChatGPT made the default, the Anthropic credits lost every model.
      // A menu that opens (refresh) asks the engine again instead of reusing its last answer.
      if ((provider !== read?.config?.model_provider || provider === 'openai') && !options.inputModality && !options.outputModality && !savedProviderKey(configHome(read), provider)) {
        // account/read describes the default connection's account, so the engine is simply asked; when it cannot list them
        // the connection is treated as an API key, as before.
        const home = configHome(read);
        const engineSignsIn = provider === 'openai' ? home && fs.existsSync(path.join(home, 'auth.json')) : Object.hasOwn(read?.config?.model_providers ?? {}, provider);
        if (home && engineSignsIn) {
          try {
            const listed = await subscriptionModels({ env: { ...process.env, ELPIS_HOME: home }, provider, refresh });
            for (const model of listed.data) clientState.models.add(model.model); // so a chat or workflow may start on them
            return listed;
          }
          catch { /* the engine could not list them: the API key route below */ }
        }
      }
      if (provider !== 'openai' || provider !== read?.config?.model_provider) {
        const definitions = { ...BUILT_IN_KEY_PROVIDERS, ...(read?.config?.model_providers ?? {}), ...(managed?.modelProviders ?? {}) };
        if (!Object.hasOwn(definitions, provider)) throw new BridgeError('This connection needs a saved API address before Elpis can list its models. Add a connection in Settings → Models & accounts.');
        try {
          const providerOptions = { savedKey: savedProviderKey(configHome(read), provider), inputModality: options.inputModality, outputModality: options.outputModality };
          return await providerModels(definitions[provider], providerOptions);
        }
        catch (error) { throw new BridgeError((/** @type {Error} */ (error)).message || 'Could not load models from this connection.', 502); }
      }
    }
    const { provider: _provider, refresh: _refresh, ...page } = options;
    const result = await internal_modelList.call(this, clientState, { ...page, limit: options.limit ?? 100, includeHidden: false }, refresh);
    for (const model of result.data) clientState.models.add(model.model);
    return result;
  }

/** The engine's list; `refresh` (a model menu opening) asks the engine to fetch it now and replaces the shared copy. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @param {{ cursor?: unknown, limit?: unknown, includeHidden?: unknown, [key: string]: unknown }} params */
export function internal_modelList(clientState, params, refresh = false) {
    if (params.cursor || params.limit !== 100 || params.includeHidden !== false) return internal_rpc.call(this, clientState, 'model/list', refresh ? { ...params, refresh } : params);
    if (refresh) {
      const pending = internal_rpc.call(this, clientState, 'model/list', { ...params, refresh });
      // A failed refresh is the menu's error; the last good list stays for the other readers.
      pending.then(() => { clientState.catalog = pending; }, () => {});
      return pending;
    }
    if (!clientState.catalog) {
      const pending = internal_rpc.call(this, clientState, 'model/list', params);
      clientState.catalog = pending;
      pending.catch(() => { if (clientState.catalog === pending) clientState.catalog = null; });
    }
    return clientState.catalog;
  }
