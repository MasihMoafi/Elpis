/** The board owns agent identity, including older chats without a Love Spot name. */
export type AgentActivity = { id: string; name: string; threadId?: string; reply: string };
const EMPTY_REPLY = '["","",""]';
export function loveActivity(elements: unknown): AgentActivity[] {
  if (!Array.isArray(elements)) return [];
  const agents = elements.flatMap((element: unknown) => {
    if (!element || typeof element !== "object") return [];
    const e = element as { id?: unknown; isDeleted?: boolean; customData?: { loveAgent?: { name?: unknown; threadId?: unknown; output?: unknown; interview?: { messages?: { role?: string; text?: string }[]; proposal?: string } } } };
    const agent = e.customData?.loveAgent;
    if (e.isDeleted || !agent || typeof e.id !== "string" || typeof agent.name !== "string") return [];
    const messages = agent.interview?.messages;
    const last = Array.isArray(messages) ? messages.filter(m => m && m.role === "assistant" && typeof m.text === "string").at(-1)?.text ?? "" : "";
    return [{ id: e.id, name: agent.name, ...(typeof agent.threadId === "string" ? { threadId: agent.threadId } : {}), reply: JSON.stringify([typeof agent.output === "string" ? agent.output : "", last, typeof agent.interview?.proposal === "string" ? agent.interview.proposal : ""]) }];
  });
  // Her replies become board notes even when Love Spot is not open.
  const replies = elements.filter((element: unknown) => {
    if (!element || typeof element !== "object") return false;
    const e = element as { id?: unknown; type?: string; isDeleted?: boolean };
    return !e.isDeleted && e.type === "text" && typeof e.id === "string" && e.id.startsWith("love-reply-");
  }) as { id: string; text?: string }[];
  return [...agents, { id: "love-board-replies", name: "Elpis", reply: replies.length ? JSON.stringify(replies.map(e => e.id).sort()) : EMPTY_REPLY }];
}

export function newLoveReplies(previous: ReadonlyMap<string, string> | null, agents: AgentActivity[]): string[] {
  if (!previous) return []; // The subscription's initial snapshot is history.
  return agents.filter(agent => previous.has(agent.id) && previous.get(agent.id) !== agent.reply && agent.reply !== EMPTY_REPLY).map(agent => agent.id);
}

export function chatOrigin(thread: { id: string; name?: string | null }, loveThreads: Readonly<Record<string, string>> = {}): "Love Spot" | "Workflows" | undefined {
  if (typeof loveThreads[thread.id] === "string" || /^Love Spot(?:\s*[·:]|$)/i.test(thread.name ?? "")) return "Love Spot";
  if (/^Workflows\s*[·:]/i.test(thread.name ?? "")) return "Workflows";
}

export function originLabel(origin: string | undefined, name: string): string | undefined {
  return origin && origin.trim().toLowerCase() !== name.trim().toLowerCase() ? origin : undefined;
}
