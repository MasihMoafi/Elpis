import { writeJson } from "./bridge-json.mts";
import type { Acp } from "./bridge-acp.mts";
import type { AcpOption,BridgeError,Catalog,CatalogResult,EffortLevels,ProviderAgent } from "./bridge-types.mts";
import { wireObject } from "./bridge-wire.mts";

type Dependencies = {
  readJson: (path: string) => Promise<Catalog | null>;
  ensureAcp: (agent: ProviderAgent) => Promise<Acp>;
  releaseAcp?: (agent: ProviderAgent, acp: Acp) => void;
  catalogs?: Map<string, Promise<CatalogResult>>;
  now: () => number;
  log: (message: string) => void;
};

/** Cache each provider's models and refresh effort levels without delaying warm starts. */
export function createProviderCatalog({ readJson, ensureAcp, releaseAcp, catalogs = new Map<string, Promise<CatalogResult>>(), now, log }: Dependencies) {
  // Each agent's models and each model's effort levels (Claude's Haiku has none; Antigravity
  // models carry their effort in the id). Reading one model's levels
  // means switching a scratch session to it (~4 s each, without touching Claude Code's saved
  // settings), so startup reads only the current model; the rest come from catalog.json and
  // cold discovery releases its temporary adapter as soon as the catalog is saved.
  const catalogFor = (agent: ProviderAgent) => {
    let catalog = catalogs.get(agent.key);
    if (!catalog) {
      catalog = readCatalog(agent).then(
        (result) => {
          if (!result.models.length && catalogs.get(agent.key) === catalog) catalogs.delete(agent.key);
          return result;
        },
        (error) => {
          if (catalogs.get(agent.key) === catalog) catalogs.delete(agent.key);
          throw error;
        },
      );
      catalogs.set(agent.key, catalog);
    }
    return catalog;
  };
  // A saved list answers at once without starting any provider adapter.
  async function readCatalog(agent: ProviderAgent) {
    const saved = await readJson(agent.catalogFile);
    const efforts = saved?.efforts ?? {};
    if (saved?.models?.length) {
      return { models: saved.models, efforts, fallback: saved.fallback ?? { levels: [], current: null }, modes: saved.modes ?? null };
    }
    return liveCatalog(agent, saved, efforts);
  }
  async function liveCatalog(agent: ProviderAgent, saved: Catalog | null, efforts: Record<string, EffortLevels>): Promise<CatalogResult> {
    let a: Acp | undefined;
    let sessionId: string | undefined;
    try {
      a = await ensureAcp(agent);
      a.discovering++;
      const s = await a.call("session/new", { cwd: process.cwd(), mcpServers: [] });
      sessionId = s.sessionId;
      const opt = (opts: AcpOption[] | null | undefined, id: string) => (opts ?? []).find((o) => o.id === id);
      const values = (option: AcpOption | undefined) => {
        const choices: { value: string; name: string; description?: string }[] = [];
        const add = (value: unknown) => { if (wireObject(value) && typeof value.value === "string" && typeof value.name === "string") choices.push({ value: value.value, name: value.name, ...(typeof value.description === "string" ? { description: value.description } : {}) }); };
        if (Array.isArray(option?.options)) for (const entry of option.options) {
          if (wireObject(entry) && Array.isArray(entry.options)) entry.options.forEach(add);
          else add(entry);
        }
        return choices;
      };
      const levelsOf = (opts: AcpOption[] | null | undefined): EffortLevels => { const e = opt(opts, "effort"); return e ? { levels: values(e).map((o) => ({ reasoningEffort: o.value, description: o.name })), current: typeof e.currentValue === "string" ? e.currentValue : null } : { levels: [], current: null }; };
      const modelOption = opt(s.configOptions, "model");
      const models = values(modelOption).filter((m) => m.value !== "default");
      const first = typeof modelOption?.currentValue === "string" ? modelOption.currentValue : undefined;
      if (first) efforts[first] = levelsOf(s.configOptions);
      const fallback = first ? efforts[first] as EffortLevels : { levels: [], current: null };
      const stale = !saved?.at || now() - saved.at > 86_400_000 || models.some((m) => !efforts[m.value]);
      // The permission modes the agent's own settings allow (Claude's can turn Bypass off), so a
      // refused switch can say why.
      const modes = s.modes?.availableModes?.map((m) => m.id) ?? null;
      await writeJson(agent.catalogFile, { at: stale && agent.key === "claude" ? 0 : (saved?.at || now()), models, efforts, fallback, modes });
      if (stale && agent.key === "claude") {
        for (const m of models.filter((m) => m.value !== first)) {
          if (a.dead || a.closing) break;
          const r = await a.call("session/set_config_option", { sessionId, configId: "model", value: m.value }).catch(() => null);
          if (r) { efforts[m.value] = levelsOf(r.configOptions); await writeJson(agent.catalogFile, { at: 0, models, efforts, fallback, modes }); }
        }
        if (!a.dead && !a.closing) {
          await writeJson(agent.catalogFile, { at: now(), models, efforts, fallback, modes });
          log(`${agent.key} catalog: effort levels of ${models.length} models saved`);
        }
      }
      return { models, efforts, fallback, modes };
    } catch (e) {
      log(`${agent.key} catalog: ${(e as BridgeError).message}`);
      return { models: [], efforts: {}, fallback: { levels: [], current: null }, modes: null };
    } finally {
      if (a) {
        a.discovering = Math.max(0, a.discovering - 1);
        if (sessionId && !a.dead && !a.closing) await a.call("session/delete", { sessionId }).catch(() => {});
        releaseAcp?.(agent, a);
      }
    }
  }
  return catalogFor;
}
