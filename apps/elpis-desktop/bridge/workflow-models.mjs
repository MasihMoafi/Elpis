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
