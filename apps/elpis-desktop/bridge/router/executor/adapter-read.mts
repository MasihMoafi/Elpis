import { object, string, messages } from "./adapter-config.mts";
import type { WorkerSession } from "./adapter-config.mts";
import type { TranscriptEvent } from "../app/host.mts";
import type { AppServerAdapter } from "./adapters.mts";

export async function runRead(this: AppServerAdapter, threadId: string): Promise<WorkerSession> {
  const conn = await this.connection(threadId);
  const response = object(await conn.call("thread/read", { threadId, includeTurns: true }));
  const thread = object(response.thread),
    turns: unknown[] = [];
  // Always walk history, including pages older than the renderer's initial window.
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = object(
      await conn.call("thread/turns/list", {
        threadId,
        limit: 100,
        sortDirection: "desc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      }),
    );
    if (!Array.isArray(page.data)) throw new Error("The runtime did not return session history");
    for (const raw of page.data) {
      const turn = object(raw),
        items = Array.isArray(turn.items) ? [...turn.items] : [];
      let itemCursor = string(object(turn.itemsPage).nextCursor);
      const itemSeen = new Set<string>();
      while (itemCursor) {
        if (itemSeen.has(itemCursor)) throw new Error("The runtime repeated a history page");
        itemSeen.add(itemCursor);
        const page = object(
          await conn.call("thread/items/list", { threadId, turnId: turn.id, cursor: itemCursor, limit: 100 }),
        );
        if (!Array.isArray(page.data)) throw new Error("The runtime did not return message history");
        items.push(...page.data);
        itemCursor = string(page.nextCursor);
      }
      turns.push({ ...turn, items });
    }
    cursor = string(page.nextCursor);
    if (cursor && seen.has(cursor)) throw new Error("The runtime repeated a history page");
    if (cursor) seen.add(cursor);
  } while (cursor);
  const active = turns.find(turn => object(turn).status === "inProgress");
  const completed = turns.find(turn => object(turn).status === "completed");
  const items = object(completed).items;
  const final = Array.isArray(items)
    ? items.findLast(item => object(item).type === "agentMessage" && object(item).phase !== "commentary")
    : undefined;
  const text = string(object(final).text),
    id = string(object(completed).id);
  const transcript: TranscriptEvent[] = turns
    .slice()
    .reverse()
    .flatMap(turn => {
      const entries = object(turn).items;
      return Array.isArray(entries)
        ? entries.flatMap((raw): TranscriptEvent[] => {
            const item = object(raw);
            if (item.type === "userMessage")
              return [
                {
                  type: "user/message",
                  data: {
                    role: "user",
                    content: Array.isArray(item.content)
                      ? item.content.map(block => ({ type: "text", text: string(object(block).text) ?? "" }))
                      : [],
                  },
                },
              ];
            if (item.type === "agentMessage")
              return [
                {
                  type: "assistant/message",
                  data: {
                    message: { role: "assistant", content: [{ type: "text", text: string(item.text) ?? "" }] },
                  },
                },
              ];
            if (item.type === "dynamicToolCall")
              return [
                {
                  type: "tool/result",
                  data: {
                    message: {
                      role: "tool",
                      content: [
                        {
                          type: "text",
                          text: JSON.stringify({
                            tool: item.tool,
                            arguments: item.arguments,
                            result: item.contentItems,
                          }),
                        },
                      ],
                    },
                  },
                },
              ];
            return [];
          })
        : [];
    });
  return {
    threadId,
    activeTurn: string(object(active).id) ?? null,
    model: string(thread.model) ?? string(response.model) ?? null,
    messages: messages(turns),
    transcript,
    ...(text && id ? { result: { id, text } } : {}),
  };
}
