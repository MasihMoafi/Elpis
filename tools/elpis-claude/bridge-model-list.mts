import type { CatalogResult,ProviderAgent } from "./bridge-types.mts";

/** Add available subscription models to the native list without blocking it indefinitely. */
export async function addSubscriptionModels(data: Record<string, unknown>[], AGENTS: ProviderAgent[], catalogFor: (agent: ProviderAgent) => Promise<CatalogResult>, log: (message: string) => void) {
      // A subscription Elpis is signed out of offers no models (and is not even started).
      const noModels: { models: CatalogResult["models"]; efforts: CatalogResult["efforts"]; fallback: CatalogResult["fallback"] | null } = { models: [], efforts: {}, fallback: null };
      const catalogWithin = (agent: ProviderAgent) => {
        let timer: NodeJS.Timeout;
        return Promise.race([catalogFor(agent), new Promise<typeof noModels>((resolve) => { timer = setTimeout(resolve, 30000, noModels); })])
          .finally(() => clearTimeout(timer));
      };
      const lists = await Promise.all(AGENTS.map((agent) => agent.signedOut?.() ? noModels : catalogWithin(agent)));
      const tpl = data[0] ?? {};
      const added: Record<string, unknown>[] = [];
      AGENTS.forEach((agent, i) => {
        const { models, efforts, fallback } = lists[i] as typeof noModels;
        for (const m of models) {
          const id = `${agent.prefix}${m.value}`;
          const e = efforts[m.value] ?? { levels: fallback?.levels ?? [], current: "default" };
          added.push({ ...tpl, id, model: id, inputModalities: ["text", "image"], displayName: `${m.name} (${agent.label})`, description: m.description ?? agent.description, hidden: false, isDefault: false, upgrade: null, upgradeInfo: null, supportedReasoningEfforts: e.levels, defaultReasoningEffort: e.current ?? "default",
            // The template's GPT-only options, which a subscription model does not have (Claude's
            // Fast mode bills extra usage, not the plan).
            additionalSpeedTiers: [], serviceTiers: [], defaultServiceTier: null, availabilityNux: null, availableAccessPrograms: null, modelSpecialty: null, supportsPersonality: false });
        }
      });
      data.unshift(...added);
      log(`model/list: added ${added.length} subscription models`);
}
