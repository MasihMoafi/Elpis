import { BridgeError, object, projectFolder, text } from './validate.mts';
import { appCatalogs, linkBundledCatalog } from './app-catalogs.mts';
import { pluginCatalogSnapshot, pluginsSnapshot, skillsSnapshot } from './customize.mts';
import { skillRoots } from './skill-trash.mts';
import { userConfigVersion, type mcpSnapshot } from './elpis-features.mts';
import type { SkillTrash } from './skill-trash.mts';
import type { createGithubConnector } from './github-connector.mts';

type Input = { cwd?: string; search?: string; cursor?: string; action: string; id: string; enabled: boolean; version: string; source: string; name: string; app: string; path: string; token: string };
type Market = NonNullable<NonNullable<Parameters<typeof pluginCatalogSnapshot>[0]>['marketplaces']>[number];
type CatalogPlugin = NonNullable<Market['plugins']>[number] & { description?: string; keywords?: string[]; interface?: { displayName?: string; shortDescription?: string; longDescription?: string } };
type EngineCatalog = Omit<NonNullable<Parameters<typeof pluginCatalogSnapshot>[0]>, 'marketplaces'> & { marketplaces?: (Omit<Market, 'plugins'> & { plugins?: CatalogPlugin[] })[] };
type EngineRead = Parameters<typeof userConfigVersion>[0] & Parameters<typeof skillRoots>[0] & { config?: { skills?: { config?: { path?: unknown }[] } } };
type Options = { rpc: (method: string, params: unknown) => Promise<unknown>; mcp: () => Promise<ReturnType<typeof mcpSnapshot>>; settings: () => Promise<{ version: string | null; features?: { data?: { key: string; enabled: boolean }[] } }>; saveSettings: (input: unknown) => Promise<unknown>; githubConnector: ReturnType<typeof createGithubConnector>; skillTrash: SkillTrash; appHome: string; home: () => string };


/** The Customize page's side of the bridge: the skills, plugins and connectors Elpis has, and the switches on them. The client
 * hands it the few things it needs (the engine call, the settings, the GitHub connector, the skill Trash) and answers the page's
 * requests through it. */
export class CustomizePage {
  #rpc; #mcp; #settings; #saveSettings; #github; #trash; #appHome; #home;
  constructor({ rpc, mcp, settings, saveSettings, githubConnector, skillTrash, appHome, home }: Options) {
    this.#rpc = rpc; this.#mcp = mcp; this.#settings = settings; this.#saveSettings = saveSettings;
    this.#github = githubConnector; this.#trash = skillTrash; this.#appHome = appHome; this.#home = home;
  }
  /** Claude's Customize page: the skills found for a project, the installed plugins and the connectors (gh and MCP).
   * A part the engine can't give says why, and the others still show. */
  #projectCwds(cwd: string | undefined) { projectFolder(cwd); return cwd ? [cwd] : []; }
  async customize(cwd?: string) {
    const cwds = this.#projectCwds(cwd), why = (error: unknown): { error: string; data?: never; version?: never; write?: never } => ({ error: error instanceof Error ? error.message : 'Unavailable' });
    const [skills, plugins, connectors, github] = await Promise.all([
      (this.#rpc('skills/list', { cwds, forceReload: true }) as Promise<Parameters<typeof skillsSnapshot>[0]>).then(skillsSnapshot, why),
      (this.#rpc('plugin/installed', cwd ? { cwds } : {}) as Promise<Parameters<typeof pluginsSnapshot>[0]>).then(pluginsSnapshot, why),
      this.#mcp().then(snapshot => ({ data: snapshot.servers.map(({ name, enabled, transport }) => ({ name, enabled, transport })), version: snapshot.version, write: snapshot.write }) as { data: { name: string; enabled: boolean; transport: string }[]; version: string | null; write: { available: boolean }; error?: never }, why),
      this.#github.snapshot().then(data => ({ data }) as { data: typeof data; error?: never }, why),
    ]);
    return { skills, plugins: { ...plugins, version: connectors.version ?? null, write: connectors.write ?? { available: false } }, connectors: { version: connectors.version ?? null, write: connectors.write ?? { available: false }, data: [...(github.data ? [github.data] : []), ...(connectors.data ?? [])],
      ...((connectors.error || github.error) ? { error: [github.error, connectors.error].filter(Boolean).join(' ') } : {}) } };
  }
  async pluginCatalog(raw: unknown = {}) {
    const input = object(raw, ['cwd', 'search', 'cursor']) as Input;
    projectFolder(input.cwd);
    if (input.search != null) text(input.search, 'plugin search', 1000);
    if (input.cursor != null) text(input.cursor, 'plugin search cursor', 4096);
    const scope = input.cwd ? { cwds: [input.cwd] } : {};
    const catalog = await this.#rpc('plugin/list', scope) as EngineCatalog;
    const term = input.search?.trim().toLowerCase();
    const snapshot = pluginCatalogSnapshot(term ? { ...catalog, marketplaces: (catalog.marketplaces ?? []).map(market => ({ ...market,
      plugins: (market.plugins ?? []).filter(plugin => [plugin.name, plugin.interface?.displayName, plugin.description, plugin.interface?.shortDescription, plugin.interface?.longDescription, ...(plugin.keywords ?? [])]
        .some(value => typeof value === 'string' && value.toLowerCase().includes(term))) })) } : catalog);
    if (term) {
      let search;
      try { search = await this.#rpc('plugin/search', { ...scope, searchTerm: input.search!.trim(), ...(input.cursor ? { cursor: input.cursor } : {}), limit: 50 }) as Parameters<typeof pluginCatalogSnapshot>[1]; }
      catch (error) {
        // A remote HTTP refusal must not prevent searching the catalogs already listed on this computer.
        if (!(error instanceof Error) || !/remote plugin catalog request to \S+ failed with status \d{3}\b/i.test(error.message)) throw error;
      }
      if (search) {
        const remote = pluginCatalogSnapshot(catalog, search), seen = new Set(snapshot.plugins.map(plugin => plugin.id));
        for (const plugin of remote.plugins) if (!seen.has(plugin.id)) { seen.add(plugin.id); snapshot.plugins.push(plugin); }
        snapshot.nextCursor = remote.nextCursor;
      }
    }
    // One plugin, one row (R35): a copy in a catalog on this computer wins over the same plugin in the remote catalog.
    const local = new Set(snapshot.plugins.filter(plugin => plugin.marketplacePath).map(plugin => plugin.pluginName));
    snapshot.plugins = snapshot.plugins.filter(plugin => plugin.marketplacePath || plugin.installed || !local.has(plugin.pluginName));
    // Two plugins with one display name (HyperFrames ships `hyperframes` and `core-skills` under one) say which is which.
    const shown = snapshot.plugins.map(plugin => plugin.name);
    for (const plugin of snapshot.plugins) if (shown.filter(name => name === plugin.name).length > 1 && plugin.pluginName !== plugin.name) plugin.name = `${plugin.name} (${plugin.pluginName})`;
    return { ...snapshot, appCatalogs: appCatalogs(this.#appHome).map(({ app, label, name }) => ({ app, label, added: snapshot.marketplaces.some(market => market.name === name) })) };
  }
  /** Turns plugins on and adds the catalog the named desktop app keeps on this computer (bridge/app-catalogs.mts). */
  async #addAppCatalog(app: string) {
    const found = appCatalogs(this.#appHome).find(catalog => catalog.app === app);
    if (!found) throw new BridgeError('That app has no plugin catalog on this computer', 404);
    await this.#enablePlugins();
    if (found.app === 'claude') return this.#rpc('marketplace/add', { source: found.source });
    const folder = await linkBundledCatalog(this.#home(), found.source), current = await this.#settings();
    return this.#rpc('config/batchWrite', { expectedVersion: current.version, reloadUserConfig: true,
      edits: [{ keyPath: `marketplaces."${found.name}"`, value: { source_type: 'local', source: folder }, mergeStrategy: 'replace' }] });
  }
  /** A marketplace is only listed while plugins are on, so adding one turns them on. */
  async #enablePlugins() {
    const { version, features } = await this.#settings();
    const plugins = features?.data?.find(feature => feature.key === 'plugins');
    if (!plugins || plugins.enabled) return;
    await this.#saveSettings({ version, features: { plugins: true } });
  }
  async changePlugin(raw?: unknown) {
    const input = object(raw, ['action', 'id', 'enabled', 'version', 'cwd']) as Input; text(input.id, 'plugin', 512);
    if (!['install', 'uninstall', 'enable'].includes(input.action)) throw new BridgeError('Choose a plugin action');
    let install = null;
    if (input.action === 'install') {
      const plugin = (await this.pluginCatalog(input.cwd ? { cwd: input.cwd } : {})).plugins.find(plugin => plugin.id === input.id);
      if (!plugin) throw new BridgeError('That plugin is not listed. Refresh the catalog.', 404);
      if (!plugin.installable) throw new BridgeError(plugin.reason);
      install = await this.#rpc('plugin/install', { pluginName: plugin.pluginName, ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : { remoteMarketplaceName: plugin.marketplaceName }) }) as { appsNeedingAuth?: { name: string }[] };
    } else {
      const snapshot = await this.customize(input.cwd);
      if (!snapshot.plugins.data?.some(plugin => plugin.id === input.id)) throw new BridgeError(('error' in snapshot.plugins && snapshot.plugins.error) || 'That plugin is not installed', 404);
      if (input.action === 'uninstall') await this.#rpc('plugin/uninstall', { pluginId: input.id });
      else {
        if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose on or off');
        text(input.version, 'plugin settings version', 200);
        if (!snapshot.plugins.write.available || snapshot.plugins.version !== input.version) throw new BridgeError('Settings changed in another client. Reload before saving again.', 409);
        await this.#rpc('config/batchWrite', { edits: [{ keyPath: `plugins.${JSON.stringify(input.id)}.enabled`, value: input.enabled, mergeStrategy: 'replace' }], expectedVersion: input.version, reloadUserConfig: true });
      }
    }
    return { ...await this.customize(input.cwd), appsNeedingAuth: install?.appsNeedingAuth?.map(app => ({ name: app.name })) ?? [] };
  }
  async changeMarketplace(raw?: unknown) {
    const input = object(raw, ['action', 'source', 'name', 'cwd', 'app']) as Input;
    // Validate the project folder before any engine mutation.
    projectFolder(input.cwd);
    if (input.action === 'add') {
      const source = text(input.source, 'marketplace source', 4096).trim();
      await this.#enablePlugins();
      return this.#rpc('marketplace/add', { source });
    }
    if (input.action === 'add-app') return this.#addAppCatalog(input.app);
    if (input.action === 'remove') return this.#rpc('marketplace/remove', { marketplaceName: text(input.name, 'marketplace', 256) });
    throw new BridgeError('Choose a marketplace action');
  }
  async setGithubConnector(raw?: unknown) {
    const input = object(raw, ['enabled', 'cwd']) as Input;
    if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose on or off');
    projectFolder(input.cwd);
    await this.#github.setEnabled(input.enabled);
    return this.customize(input.cwd);
  }
  /** Turns one listed skill on or off, then lists again. The engine's skills/config/write answers and saves nothing (22 Oct:
   * a planted skill stayed off), so the entry is written to the config's skills.config like any other setting. */
  async setSkill(raw?: unknown) {
    const input = object(raw, ['path', 'enabled', 'cwd']) as Input; text(input.path, 'skill', 4096);
    if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose on or off');
    // A switch needs the list (is it a skill?) and one config read (its entries and the version to write against), not the whole Settings page.
    const [listed, read] = await Promise.all([(this.#rpc('skills/list', { cwds: this.#projectCwds(input.cwd) }) as Promise<Parameters<typeof skillsSnapshot>[0]>).then(skillsSnapshot), this.#rpc('config/read', { includeLayers: true }) as Promise<EngineRead>]);
    if (!listed.data?.some(skill => skill.path === input.path)) throw new BridgeError('That skill is not listed', 404);
    const version = userConfigVersion(read);
    const entries = Array.isArray(read?.config?.skills?.config) ? read.config.skills.config : [];
    await this.#rpc('config/batchWrite', { expectedVersion: version, reloadUserConfig: true,
      edits: [{ keyPath: 'skills.config', value: [...entries.filter(entry => entry?.path !== input.path), { path: input.path, enabled: input.enabled }], mergeStrategy: 'replace' }] });
    // Only the skills changed: the answer is their list, not the plugins and connectors as well.
    return { skills: await (this.#rpc('skills/list', { cwds: this.#projectCwds(input.cwd), forceReload: true }) as Promise<Parameters<typeof skillsSnapshot>[0]>).then(skillsSnapshot) };
  }
  async deleteSkill(raw?: unknown) {
    const input = object(raw, ['path', 'cwd']) as Input; text(input.path, 'skill', 4096);
    const snapshot = await this.customize(input.cwd);
    if (!snapshot.skills.data) throw new BridgeError(('error' in snapshot.skills && snapshot.skills.error) || 'Skills could not be listed');
    const read = await this.#rpc('config/read', { includeLayers: true, ...(input.cwd ? { cwd: input.cwd } : {}) }) as EngineRead;
    let deleted;
    try { deleted = await this.#trash.delete(input.path, snapshot.skills.data as Parameters<SkillTrash['delete']>[1], skillRoots(read, input.cwd)); }
    catch (error) { throw new BridgeError((error as Error).message); }
    return { ...await this.customize(input.cwd), deleted };
  }
  async undoSkillDelete(raw?: unknown) {
    const input = object(raw, ['token', 'cwd']) as Input; text(input.token, 'Undo token', 128);
    projectFolder(input.cwd);
    try { await this.#trash.undo(input.token); }
    catch (error) { throw new BridgeError((error as Error).message); }
    return this.customize(input.cwd);
  }
}
