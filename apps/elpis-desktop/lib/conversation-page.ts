import { isAgentRun, type Thread } from "./api";

type ThreadPage = { data: Thread[]; nextCursor: string | null };

export async function loadConversationPage(request: (path: string) => Promise<ThreadPage>, cursor?: string | null): Promise<ThreadPage> {
  const [chats, runs] = await Promise.all([
    request(`/threads?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
    cursor ? null : request("/threads?limit=100&includeAgentRuns=true"),
  ]);
  if (!Array.isArray(chats.data) || (runs && !Array.isArray(runs.data))) throw new Error("The conversation list is unreadable");
  return { ...chats, nextCursor: chats.nextCursor ?? null, data: [...chats.data, ...(runs?.data.filter(isAgentRun) ?? [])] };
}
