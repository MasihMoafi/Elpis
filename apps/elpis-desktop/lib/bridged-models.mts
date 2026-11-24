// The engine reports its configured provider even for models served through the bridge.
export const BRIDGED_PROVIDERS = [
  { prefix: "claude/", id: "claude", label: "Anthropic" },
  { prefix: "agy/", id: "gemini", label: "Antigravity" },
  { prefix: "openai-credits/", id: "openai-credits", label: "OpenAI API credits" },
] as const;

export const bridgedProviderOf = (model?: string | null) =>
  BRIDGED_PROVIDERS.find(provider => model?.startsWith(provider.prefix)) ?? null;
