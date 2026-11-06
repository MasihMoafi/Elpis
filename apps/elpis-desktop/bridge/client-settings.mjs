import { BridgeError, object, text } from './validate.mts';
import { acceptsPastedKey, configHome, privateConfigFile, providerDefinition, providerEdits, providerSettingsSnapshot } from './provider-settings.mjs';
import { hooksSnapshot, mcpSnapshot, optionEdits, providersSnapshot, settingsSnapshot } from './elpis-features.mjs';
import { saveProviderKey, savedProviderKey, savedProviderKeyIds } from './provider-keys.mjs';

import { internal_effort } from './client-rewind.mjs';
import { internal_modelList } from './client-models.mjs';
import { internal_rpc } from './client-connection.mjs';

/** @param {unknown} value */
const string = value => typeof value === 'string' ? value : null;

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_settings(clientState) {
    const [read, requirements, pruner, featureList] = await Promise.all([
      internal_rpc.call(this, clientState, 'config/read', { includeLayers: true }),
      internal_rpc.call(this, clientState, 'configRequirements/read', {}).catch(() => null),
      internal_rpc.call(this, clientState, 'pruner/read', {}).catch(error => { if ([-32601, -32600].includes(error.code)) return null; throw error; }),
      internal_configFeatures.call(this, clientState).catch(() => null),
    ]);
    const features = featureList === null ? { available: false, reason: 'The running engine could not list features. Reopen Settings or update Elpis.', data: [] }
      : { available: true, data: featureList.filter(feature => !['removed', 'deprecated'].includes(feature.stage)).map(feature => ({
        key: feature.name, title: feature.displayName ?? feature.name, description: feature.description ?? 'Native feature default for new chats.', enabled: feature.enabled,
        reason: Object.hasOwn(requirements?.requirements?.featureRequirements ?? {}, feature.name) ? 'Managed policy controls this feature.' : null,
      })) };
    return { ...settingsSnapshot(read, requirements, pruner, savedProviderKeyIds(configHome(read))), features };
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
async function internal_configFeatures(clientState) {
    const data = [], cursors = new Set();
    /** @type {string | null | undefined} */ let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await internal_rpc.call(this, clientState, 'experimentalFeature/list', { limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result?.data)) return null;
      data.push(...result.data);
      cursor = result.nextCursor;
      if (!cursor) return data;
      if (cursors.has(cursor)) throw new BridgeError('Feature pagination repeated a cursor');
      cursors.add(cursor);
    }
    throw new BridgeError('Feature list is too long');
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_saveSettings(clientState, input) {
    object(input, ['version', 'main', 'background', 'memory', 'options', 'features']);
    text(input.version, 'settings version', 200);
    const current = await this.settings();
    if (!current.write.available) throw new BridgeError(current.write.reason, 403);
    if (current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    if (!current.managed.available) throw new BridgeError('Managed requirements could not be loaded. Reload settings before saving.', 409);
    const edits = [];
    const nullableModel = value => value === null ? null : text(value, 'model ID', 200).trim();
    // The main model (what new chats start with, in this app and the TUI) and the background model, each a model and
    // the provider it runs on; the main model can't be cleared, and a provider pinned by requirements can't change.
    const modelChoice = (choice, modelKey, providerKey, main) => {
      object(choice, ['model', 'provider']);
      if ('model' in choice) {
        if (main && choice.model === null) throw new BridgeError('Choose a main model');
        edits.push({ keyPath: modelKey, value: nullableModel(choice.model), mergeStrategy: 'replace' });
      }
      if ('provider' in choice) {
        const provider = choice.provider;
        if (provider !== null && provider !== 'openai' && !current.providers.some(item => item.id === provider)) throw new BridgeError('Choose a configured provider');
        if (main && current.managed.modelProvider && provider !== current.managed.modelProvider) throw new BridgeError('Your requirements pin the main provider', 403);
        edits.push({ keyPath: providerKey, value: provider, mergeStrategy: 'replace' });
      }
    };
    if (input.main !== undefined) modelChoice(input.main, 'model', 'model_provider', true);
    if (input.background !== undefined) modelChoice(input.background, 'background_model', 'background_provider', false);
    if (input.memory !== undefined) {
      object(input.memory, ['enabled', 'generate', 'use', 'skipExternalContext', 'extractionModel', 'consolidationModel']);
      const switches = ['enabled', 'generate', 'use', 'skipExternalContext'];
      for (const [field, key] of Object.entries({ enabled: 'features.memories', generate: 'memories.generate_memories', use: 'memories.use_memories', skipExternalContext: 'memories.disable_on_external_context', extractionModel: 'memories.extract_model', consolidationModel: 'memories.consolidation_model' })) {
        if (!(field in input.memory)) continue;
        const value = input.memory[field];
        if (switches.includes(field) && typeof value !== 'boolean') throw new BridgeError('Memory choices must be enabled or disabled');
        edits.push({ keyPath: key, value: switches.includes(field) ? value : nullableModel(value), mergeStrategy: 'replace' });
      }
    }
    if (input.options !== undefined) {
      try { edits.push(...optionEdits(input.options, current.managed, current.permissionProfiles)); }
      catch (error) { throw new BridgeError(error.message, /managed/.test(error.message) ? 403 : 400); }
    }
    if (input.features !== undefined) {
      object(input.features, current.features.data.map(feature => feature.key));
      for (const [key, value] of Object.entries(input.features)) {
        const feature = current.features.data.find(feature => feature.key === key);
        if (!current.features.available || !feature) throw new BridgeError('The engine did not advertise this feature');
        if (feature.reason) throw new BridgeError(feature.reason, 403);
        if (typeof value !== 'boolean') throw new BridgeError('Choose on or off for a feature');
        edits.push({ keyPath: `features.${JSON.stringify(key)}`, value, mergeStrategy: 'replace' });
      }
    }
    if (!edits.length) throw new BridgeError('No settings were changed');
    await internal_rpc.call(this, clientState, 'config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: false });
    clientState.catalog = null;
    return this.settings();
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_savePruner(clientState, input) {
    object(input, ['version', 'model', 'provider', 'reasoningEffort']);
    text(input.version, 'pruning settings version', 200);
    const reasoningEffort = input.reasoningEffort === null ? null : internal_effort.call(this, clientState, input.reasoningEffort);
    const current = await this.settings();
    const override = current.smartPrune.explicitOverride;
    if (!override.available) throw new BridgeError(override.reason, 409);
    if (override.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    if (input.model !== null || input.provider !== null) {
      text(input.model, 'pruning model ID', 200); text(input.provider, 'pruning provider ID', 200);
      if (!current.providers.some(item => item.id === input.provider)) throw new BridgeError('Choose a configured provider');
    }
    await internal_rpc.call(this, clientState, 'pruner/write', { expectedVersion: input.version, model: input.model, provider: input.provider, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) });
    return this.settings();
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_providers(clientState) {
    const [account, limits, read, models, anthropic] = await Promise.all([
      internal_rpc.call(this, clientState, 'account/read', { refreshToken: false }).catch(error => ({ error: error.message })),
      internal_rpc.call(this, clientState, 'account/rateLimits/read', {}).catch(error => ({ error: error.message })),
      internal_rpc.call(this, clientState, 'config/read', { includeLayers: false }),
      internal_modelList.call(this, clientState, { limit: 100, includeHidden: false }).catch(() => null),
      // Elpis's own Anthropic sign-out; a bridge that predates it has none.
      internal_rpc.call(this, clientState, 'claudeSubscription/read', {}).catch(() => null),
    ]);
    return providersSnapshot({ account, limits, config: read?.config, models: Array.isArray(models?.data) ? models.data : null, anthropic });
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_providerSettings(clientState) {
    const [read, requirements] = await Promise.all([
      internal_rpc.call(this, clientState, 'config/read', { includeLayers: true }),
      internal_rpc.call(this, clientState, 'configRequirements/read', {}).catch(() => null),
    ]);
    return providerSettingsSnapshot(read, requirements, process.env, savedProviderKeyIds(configHome(read)));
  }

/** The selected OpenRouter credential stays in the bridge and goes only to OpenRouter itself. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_readAloudProvider(clientState, id) {
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new BridgeError('Choose a configured speech provider.');
    const [read, policy] = await Promise.all([internal_rpc.call(this, clientState, 'config/read', { includeLayers: true }), internal_rpc.call(this, clientState, 'configRequirements/read', {}).catch(() => null)]);
    if (policy === null) throw new BridgeError('Provider policy is unavailable.', 503);
    if (policy.requirements?.modelProvider && policy.requirements.modelProvider !== id) throw new BridgeError('This provider is restricted by your organization.', 403);
    const definition = providerDefinition(read, id);
    let url;
    try { url = new URL(definition?.base_url); } catch { throw new BridgeError('This provider does not support read aloud.', 400); }
    if (url.protocol !== 'https:' || url.hostname !== 'openrouter.ai' || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/+$/, '') !== '/api/v1') throw new BridgeError('This provider does not support read aloud.', 400);
    const key = savedProviderKey(configHome(read), id) || (typeof definition.env_key === 'string' ? process.env[definition.env_key] : definition.experimental_bearer_token);
    if (typeof key !== 'string' || !key.trim() || /[\r\n\0]/.test(key)) throw new BridgeError('Add an OpenRouter API key under Models & accounts.', 403);
    return { baseUrl: `${url.origin}/api/v1`, key: key.trim() };
  }

/** Saves a pasted API key to the Elpis home's private key file; the key is never sent back. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_saveProviderKey(clientState, input) {
    object(input, ['provider', 'key']);
    const [read, requirements] = await Promise.all([internal_rpc.call(this, clientState, 'config/read', { includeLayers: true }), internal_rpc.call(this, clientState, 'configRequirements/read', {}).catch(() => null)]);
    const id = typeof input.provider === 'string' ? input.provider : '';
    if (requirements === null || requirements?.requirements?.modelProviders?.[id] || !acceptsPastedKey(id, providerDefinition(read, id))) throw new BridgeError('This connection does not take an API key here.', 403);
    saveProviderKey(configHome(read), id, input.key);
    return this.providerSettings();
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_saveProvider(clientState, input) {
    const current = await this.providerSettings();
    const edits = providerEdits(input, current);
    privateConfigFile(current.configPath);
    try { await internal_rpc.call(this, clientState, 'config/batchWrite', { edits, expectedVersion: input.version, reloadUserConfig: true }); clientState.catalog = null; }
    catch (error) {
      if (error.status === 409) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
      throw new BridgeError('Provider settings could not be saved. Refresh settings before retrying.', error.status ?? 502);
    }
    return this.providerSettings();
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_signIn(clientState, body) {
    object(body, ['action']);
    if (body.action === 'signOut') { await internal_rpc.call(this, clientState, 'account/logout', {}); clientState.catalog = null; return { signedOut: true }; }
    if (body.action === 'anthropicSignOut' || body.action === 'anthropicSignIn') return internal_anthropicSignedOut.call(this, clientState, body.action === 'anthropicSignOut');
    if (body.action !== 'chatgpt') throw new BridgeError('Choose a ChatGPT or Anthropic sign-in or sign-out');
    const result = await internal_rpc.call(this, clientState, 'account/login/start', { type: 'chatgpt' });
    if (typeof result?.authUrl !== 'string' || !/^https:\/\//.test(result.authUrl)) throw new BridgeError('Elpis did not return a sign-in page', 502);
    return { authUrl: result.authUrl, loginId: string(result.loginId) };
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_claudeAccounts(clientState, input) {
    if (input !== undefined) {
      object(input, ['action', 'id', 'code']);
      if (!['login', 'select', 'code'].includes(input.action)) throw new BridgeError('Choose a Claude account action');
      if (input.id !== undefined && input.id !== 'default' && !/^[a-f0-9-]{36}$/.test(input.id)) throw new BridgeError('Invalid Claude account');
      if (input.action === 'select' && typeof input.id !== 'string') throw new BridgeError('Choose a Claude account');
      if (input.action === 'code') text(input.code, 'Claude sign-in code', 4096);
    }
    let result;
    try { result = await internal_rpc.call(this, clientState, input === undefined ? 'claudeAccounts/read' : 'claudeAccounts/write', input ?? {}); }
    catch (error) {
      if ([-32601, -32600].includes(error.code) && /unknown|not found/i.test(error.engineMessage ?? error.message)) throw new BridgeError('Restart Elpis to enable Claude account switching.', 503);
      if (typeof error.engineMessage === 'string' && error.engineMessage) throw new BridgeError(error.engineMessage, error.code === -32600 ? 409 : 400);
      throw error;
    }
    if (!result || !Array.isArray(result.accounts) || typeof result.activeId !== 'string') throw new BridgeError('Claude accounts could not be read.', 502);
    // A Claude sign-in, code or switch changes which models answer, so the shared model list cannot outlive it (Masih,
    // 21 October: "the anthropic's double-login which was fixed is now broken"). A login that finishes in the
    // background is seen on the next read.
    const key = JSON.stringify([result.activeId, result.accounts.map(account => [account?.id, !!account?.authenticated, !!account?.duplicate])]);
    const changed = clientState.claudeAccountsKey !== undefined && key !== clientState.claudeAccountsKey;
    clientState.claudeAccountsKey = key;
    if (input !== undefined || changed) clientState.catalog = null;
    if (input?.action === 'select' || input?.action === 'code' || changed) this.emit('event', { type: 'account', data: { method: 'claudeAccounts/write' } });
    return result;
  }

/** Elpis's own Anthropic sign-out, kept by the Elpis bridge for the terminal and every window: only Elpis stops using
   * the Claude subscription. Claude Code's login and the ChatGPT account are not touched. Every window reloads its
   * models and usage as it does when the ChatGPT account changes. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
async function internal_anthropicSignedOut(clientState, signedOut) {
    let answer;
    try { answer = await internal_rpc.call(this, clientState, 'claudeSubscription/write', { signedOut }); }
    catch (error) {
      if (/unknown (method|variant)|method not found/i.test(error.message)) throw new BridgeError('Update and restart Elpis to sign out of Anthropic from this app.', 503);
      throw error;
    }
    clientState.catalog = null;
    this.emit('event', { type: 'account', data: { method: 'claudeSubscription/write' } });
    return { anthropicSignedOut: answer?.signedOut === true };
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_mcp(clientState) { return mcpSnapshot(await internal_rpc.call(this, clientState, 'config/read', { includeLayers: true })); }

// The Customize page (skills, plugins, connectors): bridge/customize-page.mjs.
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @returns {ReturnType<import('./customize-page.mjs').CustomizePage['customize']>} */
export function impl_customize(clientState, cwd) { return clientState.customize.customize(cwd); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState @returns {ReturnType<import('./customize-page.mjs').CustomizePage['pluginCatalog']>} */
export function impl_pluginCatalog(clientState, input) { return clientState.customize.pluginCatalog(input); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_changePlugin(clientState, input) { return clientState.customize.changePlugin(input); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_changeMarketplace(clientState, input) { return clientState.customize.changeMarketplace(input); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_setGithubConnector(clientState, input) { return clientState.customize.setGithubConnector(input); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_setSkill(clientState, input) { return clientState.customize.setSkill(input); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_deleteSkill(clientState, input) { return clientState.customize.deleteSkill(input); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export function impl_undoSkillDelete(clientState, input) { return clientState.customize.undoSkillDelete(input); }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_hooks(clientState) {
    const [list, read] = await Promise.all([internal_rpc.call(this, clientState, 'hooks/list', {}), internal_rpc.call(this, clientState, 'config/read', { includeLayers: true })]);
    return hooksSnapshot(list, read);
  }

/** Enables, disables or trusts one discovered hook through native `hooks.state`, as the Elpis terminal does. */
/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_saveHook(clientState, input) {
    object(input, ['version', 'key', 'enabled', 'trust']);
    text(input.version, 'hooks version', 200); text(input.key, 'hook', 1000);
    if ((input.enabled === undefined) === (input.trust === undefined)) throw new BridgeError('Choose enable, disable or trust');
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new BridgeError('Choose enabled or disabled');
    if (input.trust !== undefined && input.trust !== true) throw new BridgeError('Trust must be confirmed');
    const current = await this.hooks();
    if (!current.write.available || current.version !== input.version) throw new BridgeError('Settings changed in another client. Reload settings before saving again.', 409);
    const hook = current.hooks.find(item => item.key === input.key);
    if (!hook) throw new BridgeError('This hook is no longer configured. Reload hooks.', 409);
    if (hook.managed) throw new BridgeError('Managed hooks cannot be changed here', 403);
    if (input.trust && !hook.currentHash) throw new BridgeError('Elpis did not report this hook’s current version', 502);
    const state = input.trust ? { trusted_hash: hook.currentHash } : { enabled: input.enabled };
    await internal_rpc.call(this, clientState, 'config/batchWrite', { edits: [{ keyPath: 'hooks.state', value: { [hook.key]: state }, mergeStrategy: 'upsert' }], expectedVersion: input.version, reloadUserConfig: true });
    return this.hooks();
  }

/** @this {import('./client.mjs').DesktopClient} @param {import('./client-state.mjs').ClientState} clientState */
export async function impl_resetMemories(clientState, body) {
    object(body, []);
    await internal_rpc.call(this, clientState, 'memory/reset', undefined);
    return { reset: true };
  }
