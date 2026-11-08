// Claude's Customize page in Elpis (components/customize-view.tsx): the skills the engine finds for a project
// (skills/list), the plugins installed (plugin/installed) and the connectors (the MCP servers Settings lists), shaped
// for the page. Pure, so bridge/customize.test.mjs runs it without an engine.
import { ownedSkill } from "./skill-trash.mts";
type Details = { displayName?: string; shortDescription?: string };
type Skill = {
  name?: string;
  path?: string;
  interface?: Details;
  shortDescription?: string;
  description?: string;
  scope?: string;
  enabled?: boolean;
  pluginId?: string;
};
type Plugin = {
  id: string;
  name: string;
  interface?: Details;
  installed?: boolean;
  enabled?: boolean;
  installPolicy?: string;
  availability?: string;
  disabledReason?: string;
};
type Market = { name: string; path?: string | null | undefined; interface?: Details; plugins?: Plugin[] };
type Response = {
  data?: { cwd?: string; skills?: Skill[]; errors?: { message?: string; path?: string }[] }[];
  marketplaces?: Market[];
  marketplaceLoadErrors?: { marketplacePath?: string; message?: string }[];
};
type Search = {
  data?: { plugin: Plugin; marketplaceName: string; marketplacePath?: string | null }[];
  nextCursor?: string | null;
};
const SCOPES = new Set(["user", "repo", "system", "admin"]);
const list = <T,>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);
const words = (value: unknown) => (typeof value === "string" ? value : "");

/** Each skill once (a skill found under several folders is one), by name; and the files that failed to load. */
export function skillsSnapshot(response: Response | null) {
  const seen = new Set(),
    data = [],
    errors = [];
  for (const entry of list(response?.data)) {
    for (const skill of list(entry?.skills)) {
      if (typeof skill?.name !== "string" || typeof skill.path !== "string" || seen.has(skill.path)) continue;
      seen.add(skill.path);
      data.push({
        id: skill.name,
        name: words(skill.interface?.displayName) || skill.name,
        path: skill.path,
        description:
          words(skill.interface?.shortDescription) || words(skill.shortDescription) || words(skill.description),
        scope: SCOPES.has(skill.scope as string) ? skill.scope : "admin",
        enabled: skill.enabled !== false,
        plugin: words(skill.pluginId) || null,
        deletable: ownedSkill({ scope: skill.scope as string, plugin: words(skill.pluginId) }),
      });
    }
    for (const error of list(entry?.errors))
      if (typeof error?.message === "string") errors.push({ path: words(error.path), message: error.message });
  }
  return { data: data.sort((a, b) => a.name.localeCompare(b.name)), errors };
}

/** The installed plugins, by name, with the marketplace each came from. */
export function pluginsSnapshot(response: Response | null) {
  const data = [];
  for (const market of list(response?.marketplaces))
    for (const plugin of list(market?.plugins)) {
      if (!plugin?.installed || typeof plugin.id !== "string") continue;
      data.push({
        id: plugin.id,
        name: words(plugin.interface?.displayName) || words(plugin.name) || plugin.id,
        description: words(plugin.interface?.shortDescription),
        marketplace: words(market.interface?.displayName) || words(market.name),
        enabled: plugin.enabled !== false,
      });
    }
  const errors = marketplaceErrors(response);
  return {
    data: data.sort((a, b) => a.name.localeCompare(b.name)),
    ...(errors.length ? { error: errors.join(" ") } : {}),
  };
}

const marketplaceErrors = (response: Response | null) =>
  list(response?.marketplaceLoadErrors).map(
    error => `${words(error.marketplacePath) || "Marketplace"}: ${words(error.message)}`,
  );
function catalogPlugin(plugin: Plugin, market: Market) {
  const installable =
    plugin.installPolicy === "AVAILABLE" && (!plugin.availability || plugin.availability === "AVAILABLE");
  return {
    id: plugin.id,
    pluginName: plugin.name,
    name: words(plugin.interface?.displayName) || plugin.name,
    description: words(plugin.interface?.shortDescription),
    marketplace: words(market.interface?.displayName) || market.name,
    marketplaceName: market.name,
    marketplacePath: market.path ?? null,
    installed: plugin.installed === true,
    enabled: plugin.enabled === true,
    installable,
    reason: installable
      ? null
      : `Installation unavailable: ${words(plugin.disabledReason) || words(plugin.availability) || words(plugin.installPolicy) || "marketplace policy"}`,
  };
}
/** Only the engine's catalog fields needed by the Customize page; source URLs and arbitrary manifest data stay in the engine. */
export function pluginCatalogSnapshot(response: Response | null, search?: Search | null) {
  const markets = list(response?.marketplaces);
  const marketplaces = markets.map(market => ({
    name: market.name,
    displayName: words(market.interface?.displayName) || market.name,
    path: market.path ?? null,
  }));
  const plugins = search
    ? list(search.data).flatMap(item => {
        const market = markets.find(market => market.name === item.marketplaceName);
        return market ? [catalogPlugin(item.plugin, { ...market, path: item.marketplacePath })] : [];
      })
    : markets.flatMap(market => list(market.plugins).map(plugin => catalogPlugin(plugin, market)));
  return { marketplaces, plugins, errors: marketplaceErrors(response), nextCursor: search?.nextCursor ?? null };
}
