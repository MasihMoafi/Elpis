type Choice = { model: string | null; provider: string | null };
type Model = { model: string; isDefault?: boolean };
type Providers = {
  openai?: { auth?: { state?: string } };
  claude?: { state?: string; signedOut?: boolean; unavailable?: boolean };
  gemini?: { state?: string };
};

/** A new-chat default may move only when its subscription is known to be unavailable. */
export function availableDefault(current: Choice, models: Model[], providers: Providers): Choice | null {
  if (!current.model || !models.length) return null;
  const route = (model: string, provider?: string | null) => model.startsWith("claude/") ? "claude" : model.startsWith("agy/") ? "gemini" : provider ?? "openai";
  const status = (provider: string) => provider === "openai" ? providers.openai?.auth?.state : provider === "claude" ? providers.claude?.state : providers.gemini?.state;
  const selected = route(current.model, current.provider);
  if (!["openai", "claude", "gemini"].includes(selected)) return null;
  const disconnected = selected === "claude" && (providers.claude?.signedOut || providers.claude?.unavailable) || ["signedOut", "notConnected"].includes(status(selected) ?? "");
  if (!disconnected) return null;
  const candidates = models.filter(item => {
    const provider = route(item.model);
    return provider !== selected && (provider === "openai" ? status(provider) === "signedIn" : ["connected", "available"].includes(status(provider) ?? ""));
  });
  const chosen = candidates.find(item => item.isDefault) ?? candidates.find(item => route(item.model) === "openai") ?? candidates[0];
  return chosen ? { model: chosen.model, provider: "openai" } : null;
}
