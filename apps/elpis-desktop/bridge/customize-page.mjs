import { BridgeError, object, projectFolder, text } from './validate.mjs';
import { appCatalogs, linkBundledCatalog } from './app-catalogs.mjs';
import { pluginCatalogSnapshot, pluginsSnapshot, skillsSnapshot } from './customize.mjs';
import { skillRoots } from './skill-trash.mjs';
import { userConfigVersion } from './elpis-features.mjs';

/** The Customize page's side of the bridge: the skills, plugins and connectors Elpis has, and the switches on them. The client
 * hands it the few things it needs (the engine call, the settings, the GitHub connector, the skill Trash) and answers the page's
 * requests through it. */
export class CustomizePage {
  #rpc; #mcp; #settings; #saveSettings; #github; #trash; #appHome; #home;
  constructor({ rpc, mcp, settings, saveSettings, githubConnector, skillTrash, appHome, home }) {
    this.#rpc = rpc; this.#mcp = mcp; this.#settings = settings; this.#saveSettings = saveSettings;
    this.#github = githubConnector; this.#trash = skillTrash; this.#appHome = appHome; this.#home = home;
  }
  /** Claude's Customize page: the skills found for a project, the installed plugins and the connectors (gh and MCP).
   * A part the engine can't give says why, and the others still show. */
  #projectCwds(cwd) { projectFolder(cwd); return cwd ? [cwd] : []; }
  async customize(cwd) {
    const cwds = this.#projectCwds(cwd), why = error => ({ error: error instanceof Error ? error.message : 'Unavailable' });
    const [skills, plugins, connectors, github] = await Promise.all([
      this.#rpc('skills/list', { cwds, forceReload: true }).then(skillsSnapshot, why),
      this.#rpc('plugin/installed', cwd ? { cwds } : {}).then(pluginsSnapshot, why),
      this.#mcp().then(snapshot => ({ data: snapshot.servers.map(({ name, enabled, transport }) => ({ name, enabled, transport })), version: snapshot.version, write: snapshot.write }), why),
      this.#github.snapshot().then(data => ({ data }), why),
    ]);
    return { skills, plugins: { ...plugins, version: connectors.version ?? null, write: connectors.write ?? { available: false } }, connectors: { version: connectors.version ?? null, write: connectors.write ?? { available: false }, data: [...(github.data ? [github.data] : []), ...(connectors.data ?? [])],
      ...((connectors.error || github.error) ? { error: [github.error, connectors.error].filter(Boolean).join(' ') } : {}) } };
  }
  async pluginCatalog(input = {}) {
    object(input, ['cwd', 'search', 'cursor']);
    projectFolder(input.cwd);
    if (input.search != null) text(input.search, 'plugin search', 1000);
    if (input.cursor != null) text(input.cursor, 'plugin search cursor', 4096);
    const scope = input.cwd ? { cwds: [input.cwd] } : {};
    const catalog = await this.#rpc('plugin/list', scope);
    const term = input.search?.trim().toLowerCase();
    const snapshot = pluginCatalogSnapshot(term ? { ...catalog, marketplaces: (catalog.marketplaces ?? []).map(market => ({ ...market,
      plugins: (market.plugins ?? []).filter(plugin => [plugin.name, plugin.interface?.displayName, plugin.description, plugin.interface?.shortDescription, plugin.interface?.longDescription, ...(plugin.keywords ?? [])]
        .some(value => typeof value === 'string' && value.toLowerCase().includes(term))) })) } : catalog);
    if (term) {
      let search;
      try { search = await this.#rpc('plugin/search', { ...scope, searchTerm: input.search.trim(), ...(input.cursor ? { cursor: input.cursor } : {}), limit: 50 }); }
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
  /** Turns plugins on and adds the catalog the named desktop app keeps on this computer (bridge/app-catalogs.mjs). */
  async #addAppCatalog(app) {
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
  async changePlugin(input) {
    object(input, ['action', 'id', 'enabled', 'version', 'cwd']); text(input.id, 'plugin', 512);
    if (!['install', 'uninstall', 'enable'].includes(input.action)) throw new BridgeError('Choose a plugin action');
    let install = null;
    if (input.action === 'install') {
      const plugin = (await this.pluginCatalog(input.cwd ? { cwd: input.cwd } : {})).plugins.find(plugin => plugin.id === input.id);
      if (!plugin) throw new BridgeError('That plugin is not listed. Refresh the catalog.', 404);
      if (!plugin.installable) throw new BridgeError(plugin.reason);
      install = await this.#rpc('plugin/install', { pluginName: plugin.pluginName, ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : { remoteMarketplaceName: plugin.marketplaceName }) });
    } else {
      const snapshot = await this.customize(input.cwd);
      if (!snapshot.plugins.data?.some(plugin => plugin.id === input.id)) throw new BridgeError(snapshot.plugins.error || 'That plugin is not installed', 404);
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
  async changeMarketplace(input) {
    object(input, ['action', 'source', 'name', 'cwd', 'app']);
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
  async setGithubConnector(input) {
    object(input, ['enabled', 'cwd']);
    if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose on or off');
    projectFolder(input.cwd);
    await this.#github.setEnabled(input.enabled);
    return this.customize(input.cwd);
  }
  /** Turns one listed skill on or off, then lists again. The engine's skills/config/write answers and saves nothing (22 Oct:
   * a planted skill stayed off), so the entry is written to the config's skills.config like any other setting. */
  async setSkill(input) {
    object(input, ['path', 'enabled', 'cwd']); text(input.path, 'skill', 4096);
    if (typeof input.enabled !== 'boolean') throw new BridgeError('Choose on or off');
    // A switch needs the list (is it a skill?) and one config read (its entries and the version to write against), not the whole Settings page.
    const [listed, read] = await Promise.all([this.#rpc('skills/list', { cwds: this.#projectCwds(input.cwd) }).then(skillsSnapshot), this.#rpc('config/read', { includeLayers: true })]);
    if (!listed.data?.some(skill => skill.path === input.path)) throw new BridgeError('That skill is not listed', 404);
    const version = userConfigVersion(read);
    const entries = Array.isArray(read?.config?.skills?.config) ? read.config.skills.config : [];
    await this.#rpc('config/batchWrite', { expectedVersion: version, reloadUserConfig: true,
      edits: [{ keyPath: 'skills.config', value: [...entries.filter(entry => entry?.path !== input.path), { path: input.path, enabled: input.enabled }], mergeStrategy: 'replace' }] });
    // Only the skills changed: the answer is their list, not the plugins and connectors as well.
    return { skills: await this.#rpc('skills/list', { cwds: this.#projectCwds(input.cwd), forceReload: true }).then(skillsSnapshot) };
  }
  async deleteSkill(input) {
    object(input, ['path', 'cwd']); text(input.path, 'skill', 4096);
    const snapshot = await this.customize(input.cwd);
    if (!snapshot.skills.data) throw new BridgeError(snapshot.skills.error || 'Skills could not be listed');
    const read = await this.#rpc('config/read', { includeLayers: true, ...(input.cwd ? { cwd: input.cwd } : {}) });
    let deleted;
    try { deleted = await this.#trash.delete(input.path, snapshot.skills.data, skillRoots(read, input.cwd)); }
    catch (error) { throw new BridgeError(error.message); }
    return { ...await this.customize(input.cwd), deleted };
  }
  async undoSkillDelete(input) {
    object(input, ['token', 'cwd']); text(input.token, 'Undo token', 128);
    projectFolder(input.cwd);
    try { await this.#trash.undo(input.token); }
    catch (error) { throw new BridgeError(error.message); }
    return this.customize(input.cwd);
  }
}
