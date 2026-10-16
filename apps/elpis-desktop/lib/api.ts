export type Thread = {
  id: string; cwd?: string; name?: string | null; workflowTaskTitle?: string; preview?: string; model?: string | null; modelProvider?: string;
  reasoningEffort?: string | null; parentThreadId?: string | null; forkedFromId?: string | null;
  updatedAt?: number; recencyAt?: number;
  agentNickname?: string | null; agentRole?: string | null;
  source?: string | {subAgent?:unknown;custom?:string};
  status?: { type: string; activeFlags?: string[] };
  desktopAccess?: { writable: boolean; mode?: "direct" | "continue"; reason: string | null };
};
export type Item = { id: string; type: string; text?: string; content?: {type: string; text?: string}[]; command?: string; aggregatedOutput?: string; [key: string]: unknown };
export type Entry = { turnId: string; item: Item; startedAtMs?: number; completedAtMs?: number };
export type Model = { id: string; model: string; displayName: string; description?: string; inputModalities?: string[]; supportedReasoningEfforts?: {reasoningEffort:string;description?:string}[]; defaultReasoningEffort?: string };
export type ProviderSettings = { version?:string|null; main:{model:string|null;provider:string|null}; providers:{id:string;displayName:string;needsKey?:boolean}[]; options?:{approvalPolicy:string|null;sandboxMode:string|null}; managed?:{modelProvider:string|null} };
export type Approval = { id: string; ownerThreadId: string; thread?: Thread; method: string; supported?: boolean; params: { availableDecisions?: unknown[]; threadId?: string; command?: string; reason?: string; changes?: unknown; questions?: {id:string;header:string;question:string;isSecret?:boolean;options?:{label:string;description?:string}[]}[] } };
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || result.error || `Request failed (${response.status})`);
  return result;
}
const spawn = (thread: Thread) => {
  const source = thread.source;
  if (!source || typeof source !== "object" || !("subAgent" in source)) return null;
  const sub = source.subAgent as Record<string, unknown> | null;
  const spawned = sub && typeof sub === "object" ? sub.thread_spawn ?? sub.threadSpawn : null;
  return spawned && typeof spawned === "object" ? spawned as Record<string, unknown> : null;
};
/** The task a parent gave a spawned agent, recorded as the last segment of its agent path. */
export function taskOf(thread: Thread) { return taskFromPath(spawn(thread)?.agent_path ?? spawn(thread)?.agentPath); }
export function taskFromPath(path: unknown) {
  const task = typeof path === "string" ? path.split("/").filter(Boolean).at(-1)?.replace(/[_-]+/g, " ").trim() : "";
  return task ? task[0].toUpperCase() + task.slice(1) : "";
}
/** Use recorded task metadata before an agent's instruction preamble. */
export function title(thread: Thread) {
  if (thread.name?.trim()) return thread.name.trim();
  if (thread.workflowTaskTitle?.trim()) return thread.workflowTaskTitle.trim();
  const task = taskOf(thread);
  if (task) return task;
  const preview = thread.preview?.trim().split(/\r?\n/)[0].slice(0, 80);
  if (preview && (!isAgent(thread) || !/^you are\b/i.test(preview))) return preview;
  return isAgent(thread) ? `Untitled agent · ${thread.id.slice(-8)}` : "Untitled conversation";
}
const subAgentSource = (thread: Thread) => typeof thread.source === "object" && thread.source !== null && "subAgent" in thread.source;
export const isUnlinkedAgent = (thread:Thread,threads:Thread[]) => thread.parentThreadId
  ? !threads.some(parent=>parent.id===thread.parentThreadId)
  : subAgentSource(thread);
export const isAgent = (thread: Thread) => !!thread.parentThreadId || subAgentSource(thread);

// Subscription models reach Elpis through its bridge by a model-ID prefix while the engine still
// reports its own provider, so the model is the truthful source of the provider.
export const SUBSCRIPTIONS = [
  { prefix: "claude/", id: "claude", label: "Anthropic" },
  { prefix: "agy/", id: "gemini", label: "Antigravity" },
] as const;
export const subscriptionOf = (model?: string | null) => SUBSCRIPTIONS.find(item => model?.startsWith(item.prefix)) ?? null;
const providerNames: Record<string, string> = {
  openai: "OpenAI", lmstudio: "LM Studio", ollama: "Ollama", openrouter: "OpenRouter",
  anthropic: "Anthropic API", "anthropic-credits": "Anthropic credits", "google-gemini": "Google Gemini",
  "amazon-bedrock": "Amazon Bedrock", "amazon-bedrock-runtime": "Amazon Bedrock Runtime",
};
export function providerLabel(model: string | null | undefined, provider: string | null | undefined, providers: ProviderSettings["providers"] = []) {
  const subscription = subscriptionOf(model);
  if (subscription) return subscription.label;
  if (!provider) return "";
  const saved = providers.find(item => item.id === provider)?.displayName?.trim();
  const name = providerNames[provider];
  if (name) return name;
  if (!saved) return provider;
  const sameNames = providers.filter(item => item.displayName?.trim() === saved).sort((a, b) => a.id.localeCompare(b.id));
  return sameNames.length > 1 ? `${saved} (${sameNames.findIndex(item => item.id === provider) + 1})` : saved;
}
/** A subscription model's name without the route its bridge appends, since the provider is shown beside it. */
export const modelName = (name: string) => name.replace(/\s*\((Claude subscription|Antigravity)\)$/, "");
export function modelLabel(model: string | null | undefined, models: Model[] = []) {
  if (!model) return "Model not reported";
  return modelName(models.find(item => item.model === model)?.displayName || model);
}

export type Activity = { label: string; at: number };
const firstLine = (value: unknown) => typeof value === "string" ? value.replace(/[`*]+/g, "").trim().split("\n")[0].replace(/^[#>\s-]+/, "").slice(0, 120) : "";
/** One line saying what an agent is doing, from the native item it just started or finished. */
export function activityOf(method: string, params: Record<string, unknown>): string | null {
  const item = (params.item ?? {}) as Record<string, unknown>;
  if (method === "item/agentMessage/delta") return null;
  if (method === "turn/started") return "Thinking…";
  if (method !== "item/started" && method !== "item/completed") return null;
  const done = method === "item/completed";
  switch (item.type) {
    case "commandExecution": return `${done ? "Ran" : "Running"}: ${firstLine(item.command)}`;
    case "mcpToolCall": return `${done ? "Used" : "Using"} ${[item.server, item.tool].filter(Boolean).join(".")}`;
    case "dynamicToolCall": return `${done ? "Used" : "Using"} ${firstLine(item.tool) || "a tool"}`;
    case "fileChange": return `${done ? "Changed" : "Changing"} ${Array.isArray(item.changes) ? item.changes.length : ""} file${Array.isArray(item.changes) && item.changes.length === 1 ? "" : "s"}`;
    case "collabAgentToolCall": return `${done ? "Agent" : "Starting agent"}: ${firstLine(item.prompt) || firstLine(item.tool)}`;
    case "webSearch": return `Searching: ${firstLine(item.query)}`;
    case "reasoning": return done ? null : "Thinking…";
    case "agentMessage": return done ? `Said: ${firstLine(item.text)}` : "Writing…";
    default: return null;
  }
}

/** Where a new chat can run: the engine's provider, each subscription the bridge offers, and other configured providers.
 * Choice IDs: "" for the engine, the model prefix for a subscription, the provider ID otherwise. */
export type ProviderChoice = { id: string; label: string; provider?: string; models: Model[]; catalogVersion?: string | null; needsKey?: boolean };
/** Engine providers the model list leaves out: the local gpt-oss servers and Amazon Bedrock. */
const UNLISTED = new Set(["ollama", "lmstudio", "amazon-bedrock", "amazon-bedrock-runtime"]);
/** Where each connection sits in the list: Anthropic's first, OpenRouter second to last, Google Gemini last. */
const ORDER = ["claude/", "anthropic-credits", "anthropic", "agy/", "openrouter", "google-gemini"];
const rank = (id: string) => { const index = ORDER.indexOf(id); return index < 0 ? ORDER.indexOf("agy/") - 0.5 : index; };
export function providerChoices(models: Model[], settings: ProviderSettings | null): ProviderChoice[] {
  const main = settings?.main.provider ?? null;
  const others: ProviderChoice[] = [
    ...SUBSCRIPTIONS.map(item => ({ id: item.prefix, label: item.label, models: models.filter(model => model.model.startsWith(item.prefix)) })).filter(choice => choice.models.length),
    ...(settings?.providers ?? []).filter(item => item.id !== main && !UNLISTED.has(item.id) && !(settings?.managed?.modelProvider && settings.managed.modelProvider !== item.id))
      .map(item => ({ id: item.id, label: providerLabel(null, item.id, settings?.providers), provider: item.id, models: [], catalogVersion: settings?.version, ...(item.needsKey ? { needsKey: true } : {}) })),
  ];
  return [
    { id: "", label: providerLabel(null, main, settings?.providers) || "Configured provider", models: models.filter(model => !subscriptionOf(model.model)) },
    ...others.sort((a, b) => rank(a.id) - rank(b.id) || a.label.localeCompare(b.label)),
  ];
}
/** The choice an existing chat runs under: its subscription, its own configured provider, or the engine. */
export function choiceOf(thread: Thread, choices: ProviderChoice[]) {
  const subscription = subscriptionOf(thread.model);
  return choices.find(choice => subscription ? choice.id === subscription.prefix : !!thread.modelProvider && choice.provider === thread.modelProvider) ?? choices[0];
}
export const effortsOf = (model: string | null | undefined, models: Model[]) => models.find(item => item.model === model)?.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? [];
