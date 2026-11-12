type UsageWindow = { usedPercent?: number | null; resetsAt?: number | null };
type Credits = { hasCredits?: boolean | null; unlimited?: boolean | null } | null;
type Usage = ({ primary?: UsageWindow | null; secondary?: UsageWindow | null; credits?: Credits } | null)[];
type Provider = {
  state?: string;
  signedOut?: boolean;
  auth?: { state?: string; method?: string | null };
  usage?: Usage;
};
type CatalogModel = {
  model: string;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  defaultReasoningEffort?: string | null;
};

/** Subscription routes only: automatic workflow recovery never starts a metered API connection. */
export function workflowRoute(model: string = "", provider: string = "") {
  return {
    model,
    provider: model.startsWith("claude/") ? "claude" : model.startsWith("agy/") ? "agy" : provider || "openai",
  };
}
const providerName = (provider: string) =>
  provider === "claude" ? "Claude" : provider === "agy" ? "Antigravity" : provider === "openai" ? "ChatGPT" : provider;

/** What he does next, for whom the model was chosen: a workflow's agent is resumed, an automation simply runs again. */
const another = (whom: "agent" | "automation") =>
  whom === "agent" ? "choose another model for this agent and resume" : "choose another model for this automation";

/** The one line an agent's chat and its run's record show when its subscription has no quota left. An agent never moves
 * to another subscription (E17, 11 Nov, Masih: "I never permitted opus"), so the line says what he can do. `resetsAt` in
 * seconds, when the usage data has it; `during`: the limit was reached while the agent worked. An automation's run uses
 * the same line (E26, 12 Nov). */
export function quotaStopLine(
  route: { model: string; provider: string },
  during: boolean,
  resetsAt?: number | null,
  whom: "agent" | "automation" = "agent",
) {
  const name = providerName(route.provider);
  const until = resetsAt
    ? ` until ${new Date(resetsAt * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`
    : "";
  const why = during
    ? `stopped because the ${name} usage limit was reached during its work`
    : `did not run because the ${name} usage limit is reached${until}`;
  return `${route.model || name} on ${name} ${why}; wait for the reset, or ${another(whom)}.`;
}
/** The line for a chosen model the current model list no longer has (or never had): nothing runs on another model. */
export function unlistedModelLine(route: { model: string; provider: string }, whom: "agent" | "automation" = "agent") {
  const name = providerName(route.provider);
  return `${route.model} on ${name} did not run because it is not in the current model list; ${another(whom)}.`;
}
export function quotaFailure(error: unknown) {
  const details = error as { errorKind?: string; message?: string } | null | undefined;
  return (
    /^(usage_limit_reached|rate_limit_error|quota_exceeded|insufficient_quota)$/.test(details?.errorKind ?? "") ||
    /\b(?:hit|reached|exceeded|exhausted)\s+(?:your\s+|the\s+)?(?:weekly|monthly|daily|usage|plan|credit)\s+(?:usage\s+)?(?:limit|quota)\b/i.test(
      details?.message ?? "",
    ) ||
    /(?:weekly|monthly|daily|usage|plan|credit).{0,60}(?:limit|quota).{0,40}(?:reach|exceed|exhaust)|(?:rate[_ -]?limit|quota)[_ -]?(?:error|exceeded|exhausted|reached)|too many requests/i.test(
      details?.message ?? "",
    )
  );
}
export function workflowModelRoutes(
  models: CatalogModel[],
  providers: { openai?: Provider; claude?: Provider; gemini?: Provider },
  requirements?: { modelProvider?: string } | null,
) {
  const now = Date.now() / 1000;
  // A full plan window blocks the subscription only when it has no credits to go on with (E17, 11 Nov, Masih: "chatpgt
  // limit is reached; but I have credits so luna is still the option"). The engine reports credits beside each limit.
  const blocking = (usage: Usage | undefined) =>
    usage?.some(limit => limit?.credits?.hasCredits || limit?.credits?.unlimited)
      ? []
      : (usage ?? []).flatMap(limit =>
          [limit?.primary, limit?.secondary].filter(
            (window): window is UsageWindow =>
              window != null &&
              (window.usedPercent ?? 0) >= 100 &&
              (window.resetsAt === null || window.resetsAt === undefined || window.resetsAt > now),
          ),
        );
  const subscriptions = [
    {
      id: "openai",
      connected: providers.openai?.auth?.state === "signedIn" && providers.openai.auth.method === "ChatGPT",
      usage: providers.openai?.usage,
    },
    {
      id: "claude",
      connected: ["connected", "available"].includes(providers.claude?.state ?? "") && !providers.claude?.signedOut,
      usage: providers.claude?.usage,
    },
    {
      id: "agy",
      connected: ["connected", "available"].includes(providers.gemini?.state ?? ""),
      usage: providers.gemini?.usage,
    },
  ];
  return subscriptions.flatMap(subscription => {
    if (!subscription.connected || (requirements?.modelProvider && requirements.modelProvider !== subscription.id))
      return [];
    const listed = models
      .filter(item => workflowRoute(item.model).provider === subscription.id)
      .sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
    const full = blocking(subscription.usage),
      // When it can be used again: the last of its full windows to reset, if each says when.
      resetsAt = full.every(window => typeof window.resetsAt === "number")
        ? Math.max(...full.map(window => window.resetsAt as number))
        : null;
    return listed.map(item => ({
      model: item.model,
      provider: subscription.id,
      exhausted: full.length > 0,
      ...(full.length
        ? { reason: `${providerName(subscription.id)} usage limit reached`, ...(resetsAt ? { resetsAt } : {}) }
        : {}),
      efforts: item.supportedReasoningEfforts?.map(option => option.reasoningEffort).filter(Boolean),
      defaultEffort: item.defaultReasoningEffort,
    }));
  });
}

/** The Mother's model: one setting. 3 Nov, Masih: Opus 5.5 medium on the Claude subscription ("we no longer have promo
 * credits! use the sub!"); Sonnet at low is her fallback on the same subscription. */
export const MOTHER_ROUTE = { model: "claude/opus", provider: "claude", reasoningEffort: "medium" };
export const MOTHER_FALLBACK = { model: "claude/sonnet", provider: "claude", reasoningEffort: "low" };

/** Default models for a run's agents, read from the real catalogues. A model he set on an agent always wins; these fill
 * only what he left empty. Children: the smallest non-Argon Gemini Antigravity lists (1 Nov, Masih: "use gemini-3.8 or a
 * smaller gemini if it offers. not argon"), at its medium level. The Mother: MOTHER_ROUTE, else MOTHER_FALLBACK, when
 * the catalogue lists them (the Claude subscription is signed in). `null` where the catalogue lacks it: the run keeps its
 * earlier choice. */
export function workflowDefaults(catalog: { model?: unknown }[] = []) {
  const ids = catalog.map(item => item?.model).filter((id): id is string => typeof id === "string");
  const size = (id: string) => (/lite|nano/i.test(id) ? 0 : /flash/i.test(id) ? 1 : 2);
  const gemini = ids.filter(id => /^agy\/gemini-/i.test(id) && !/argon/i.test(id) && size(id) < 2);
  const smallest = Math.min(...gemini.map(size)),
    family = gemini.filter(id => size(id) === smallest);
  const child = family.find(id => /-medium$/.test(id)) ?? family[0] ?? null;
  const listed = new Set(ids);
  const routes = [MOTHER_ROUTE, MOTHER_FALLBACK].filter(route => listed.has(route.model));
  return {
    child: child ? { model: child, provider: "agy" } : null,
    mother: routes[0] ?? null,
    motherFallback: routes[1] ?? null,
  };
}
