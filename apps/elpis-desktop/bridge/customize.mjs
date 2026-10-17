// Claude's Customize page in Elpis (components/customize-view.tsx): the skills the engine finds for a project
// (skills/list), the plugins installed (plugin/installed) and the connectors (the MCP servers Settings lists), shaped
// for the page. Pure, so bridge/customize.test.mjs runs it without an engine.
const SCOPES = new Set(['user', 'repo', 'system', 'admin']);
const list = value => Array.isArray(value) ? value : [];
const words = value => typeof value === 'string' ? value : '';

/** Each skill once (a skill found under several folders is one), by name; and the files that failed to load. */
export function skillsSnapshot(response) {
  const seen = new Set(), data = [], errors = [];
  for (const entry of list(response?.data)) {
    for (const skill of list(entry?.skills)) {
      if (typeof skill?.name !== 'string' || typeof skill.path !== 'string' || seen.has(skill.path)) continue;
      seen.add(skill.path);
      data.push({
        id: skill.name, name: words(skill.interface?.displayName) || skill.name, path: skill.path,
        description: words(skill.interface?.shortDescription) || words(skill.shortDescription) || words(skill.description),
        scope: SCOPES.has(skill.scope) ? skill.scope : 'user', enabled: skill.enabled !== false, plugin: words(skill.pluginId) || null,
      });
    }
    for (const error of list(entry?.errors)) if (typeof error?.message === 'string') errors.push({ path: words(error.path), message: error.message });
  }
  return { data: data.sort((a, b) => a.name.localeCompare(b.name)), errors };
}

/** The installed plugins, by name, with the marketplace each came from. */
export function pluginsSnapshot(response) {
  const data = [];
  for (const market of list(response?.marketplaces)) for (const plugin of list(market?.plugins)) {
    if (!plugin?.installed || typeof plugin.id !== 'string') continue;
    data.push({ id: plugin.id, name: words(plugin.interface?.displayName) || words(plugin.name) || plugin.id, description: words(plugin.interface?.shortDescription),
      marketplace: words(market.interface?.displayName) || words(market.name), enabled: plugin.enabled !== false });
  }
  return { data: data.sort((a, b) => a.name.localeCompare(b.name)) };
}
