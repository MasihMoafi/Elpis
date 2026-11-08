import { z } from "zod";
import type { ElpisChatMessage, ElpisChatTransport } from "./elpis-chat.mts";

const EntrySchema = z.object({
  turnId: z.string(),
  startedAtMs: z.number().nullish(),
  completedAtMs: z.number().nullish(),
  item: z.looseObject({
    id: z.string(),
    type: z.string(),
    text: z.string().optional(),
    content: z.unknown().optional(),
  }),
});
const ContentSchema = z.array(
  z.looseObject({
    type: z.string(),
    text: z.string().optional(),
    url: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
  }),
);
interface ChatClient {
  readThread(
    threadId: string,
    options: { limit: number; cursor?: string },
  ): Promise<{ thread: { id: string }; data: unknown[]; nextCursor?: string | null }>;
  appendAssistant(threadId: string, reply: { id: string; text: string }): Promise<"sent" | "gone">;
}

/** Reads the same paginated history as the desktop, without resuming a thread or starting a model turn. */
export function createElpisChatTransport(client: ChatClient): ElpisChatTransport {
  return {
    async read(threadId, after, signal) {
      const messages: ElpisChatMessage[] = [],
        cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        signal?.throwIfAborted();
        const page = await client.readThread(threadId, { limit: 100, ...(cursor ? { cursor } : {}) });
        signal?.throwIfAborted();
        if (page.thread.id !== threadId) throw new Error("Elpis returned another chat");
        for (const raw of page.data) {
          const entry = EntrySchema.parse(raw);
          const id = `${entry.turnId}:${entry.item.id}`;
          if (id === after) return messages.reverse();
          if (entry.item.type !== "userMessage" && entry.item.type !== "agentMessage") continue;
          const role = entry.item.type === "userMessage" ? "user" : "assistant";
          const content = role === "user" ? ContentSchema.parse(entry.item.content) : [];
          const images = content.flatMap((block, index) =>
            block.type === "image" && block.url ? [{ id: `image-${index}`, url: block.url }] : [],
          );
          const text =
            role === "user"
              ? [
                  ...content.flatMap(block =>
                    block.type === "text"
                      ? [block.text ?? ""]
                      : block.type === "mention"
                        ? [`${block.name}: ${block.path}`]
                        : [],
                  ),
                  ...images.map(image => `[image:${image.id}]`),
                ].join("\n")
              : (entry.item.text ?? "");
          messages.push({
            id,
            threadId,
            role,
            text,
            ...(images.length ? { images } : {}),
            actorId: role === "user" ? "local-user" : "mother",
            at: new Date(entry.startedAtMs ?? entry.completedAtMs ?? Date.now()).toISOString(),
          });
        }
        const next = page.nextCursor;
        if (!next) return messages.reverse();
        if (cursors.has(next)) throw new Error("Elpis chat history repeated a cursor");
        cursors.add(next);
        cursor = next;
      } while (cursor);
      return messages.reverse();
    },
    async appendAssistant(threadId, reply) {
      try {
        return await client.appendAssistant(threadId, reply);
      } catch (error) {
        const failure = error as { code?: unknown; engineMessage?: unknown };
        if (
          failure?.code === -32600 &&
          (failure.engineMessage === `thread not found: ${threadId}` ||
            failure.engineMessage === `no rollout found for thread id ${threadId}`)
        )
          return "gone";
        throw error;
      }
    },
  };
}
