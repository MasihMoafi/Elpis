/** Subscription routes only: automatic workflow recovery never starts a metered API connection. */
export function workflowRoute(model = '', provider = '') {
  return { model, provider: model.startsWith('claude/') ? 'claude' : model.startsWith('agy/') ? 'agy' : provider || 'openai' };
}
export function quotaFailure(error) {
  return /^(usage_limit_reached|rate_limit_error|quota_exceeded|insufficient_quota)$/.test(error?.errorKind ?? '')
    || /\b(?:hit|reached|exceeded|exhausted)\s+(?:your\s+|the\s+)?(?:weekly|monthly|daily|usage|plan|credit)\s+(?:usage\s+)?(?:limit|quota)\b/i.test(error?.message ?? '')
    || /(?:weekly|monthly|daily|usage|plan|credit).{0,60}(?:limit|quota).{0,40}(?:reach|exceed|exhaust)|(?:rate[_ -]?limit|quota)[_ -]?(?:error|exceeded|exhausted|reached)|too many requests/i.test(error?.message ?? '');
}
export function workflowModelRoutes(models, providers, requirements) {
  const now = Date.now() / 1000;
  const exhausted = usage => usage?.some(limit => [limit.primary, limit.secondary].some(window => window?.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt === undefined || window.resetsAt > now)));
  const subscriptions = [
    { id: 'openai', connected: providers.openai?.auth?.state === 'signedIn' && providers.openai.auth.method === 'ChatGPT', usage: providers.openai?.usage },
    { id: 'claude', connected: ['connected', 'available'].includes(providers.claude?.state) && !providers.claude?.signedOut, usage: providers.claude?.usage },
    { id: 'agy', connected: ['connected', 'available'].includes(providers.gemini?.state), usage: providers.gemini?.usage },
  ];
  return subscriptions.flatMap(subscription => {
    if (!subscription.connected || requirements?.modelProvider && requirements.modelProvider !== subscription.id) return [];
    const listed = models.filter(item => workflowRoute(item.model).provider === subscription.id).sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault));
    return listed.map(item => ({ model: item.model, provider: subscription.id, exhausted: !!exhausted(subscription.usage),
      ...(exhausted(subscription.usage) ? { reason: `${subscription.id === 'claude' ? 'Claude' : subscription.id === 'agy' ? 'Antigravity' : 'ChatGPT'} usage limit reached` } : {}),
      efforts: item.supportedReasoningEfforts?.map(option => option.reasoningEffort).filter(Boolean), defaultEffort: item.defaultReasoningEffort }));
  });
}

/** The Mother's model: one setting (1 Nov, Masih: "sonnet 5.5 via promo credits or opus 5.5 medium or low via promo
 * credits"; for presentations she will run on Opus, so that switch is a change here). Ids from the credits catalogue
 * (`elpis-next -c model_provider=anthropic-credits debug models`, 1 Nov). */
export const MOTHER_ROUTE = { model: 'claude-sonnet-5-5', provider: 'anthropic-credits', reasoningEffort: 'low' };
export const MOTHER_FALLBACK = { model: 'claude-opus-5-5', provider: 'anthropic-credits', reasoningEffort: 'medium' };

/** Default models for a run's agents, read from the real catalogues. A model he set on an agent always wins; these fill
 * only what he left empty. Children: the smallest non-Argon Gemini Antigravity lists (1 Nov, Masih: "use gemini-3.8 or a
 * smaller gemini if it offers. not argon"), at its medium level. The Mother: MOTHER_ROUTE, else MOTHER_FALLBACK, when
 * the credits connection lists them. `null` where the catalogue lacks it: the run keeps its earlier choice. */
export function workflowDefaults(catalog = [], credits = []) {
  const ids = catalog.map(item => item?.model).filter(id => typeof id === 'string');
  const size = id => /lite|nano/i.test(id) ? 0 : /flash/i.test(id) ? 1 : 2;
  const gemini = ids.filter(id => /^agy\/gemini-/i.test(id) && !/argon/i.test(id) && size(id) < 2);
  const smallest = Math.min(...gemini.map(size)), family = gemini.filter(id => size(id) === smallest);
  const child = family.find(id => /-medium$/.test(id)) ?? family[0] ?? null;
  const listed = new Set(credits.map(item => item?.model));
  const routes = [MOTHER_ROUTE, MOTHER_FALLBACK].filter(route => listed.has(route.model));
  return { child: child ? { model: child, provider: 'agy' } : null, mother: routes[0] ?? null, motherFallback: routes[1] ?? null };
}
