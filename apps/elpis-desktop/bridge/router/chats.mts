/**
 * His chats through the desktop client, for the router's chat tools: the same list, history and actions the window
 * uses, so the router sees and does what he would in the sidebar. Nothing here deletes a chat.
 */
import { z } from "zod";

export type ChatState = "working" | "needs you" | "failed" | "idle";
export interface Chat {
  id: string;
  title: string;
  state: ChatState;
  folder?: string;
  model?: string;
  /** When it last changed, as an ISO time. */
  updated?: string;
  archived?: boolean;
}
export interface ChatMessage {
  from: "person" | "agent";
  text: string;
  at?: string;
}
export interface ChatStart {
  text: string;
  name?: string | undefined;
  folder?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}
export interface Chats {
  /** One page of his chats, newest first; `next` continues after it when there are more. */
  list(options: {
    archived?: boolean;
    search?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<{ chats: Chat[]; next?: string }>;
  read(id: string, limit: number): Promise<{ chat: Chat; messages: ChatMessage[] }>;
  send(id: string, text: string): Promise<void>;
  start(input: ChatStart): Promise<Chat>;
  stop(id: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  archive(id: string): Promise<void>;
  restore(id: string): Promise<void>;
}

/** The part of the desktop client the router's chat tools use. */
export interface ChatsClient {
  listThreads(options: { limit: number; searchTerm?: string; cursor?: string }): Promise<unknown>;
  listArchivedThreads(options: { limit: number; cursor?: string }): Promise<unknown>;
  readThread(id: string, options: { limit: number }): Promise<unknown>;
  createThread(body: { cwd?: string; model?: string; name?: string }): Promise<unknown>;
  send(id: string, body: { text: string; effort?: string }): Promise<unknown>;
  interrupt(id: string, body: Record<string, never>): Promise<unknown>;
  renameThread(id: string, body: { name: string }): Promise<unknown>;
  archiveThread(id: string, body: Record<string, never>): Promise<unknown>;
  unarchiveThread(id: string, body: Record<string, never>): Promise<unknown>;
}

const ThreadSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullish(),
  preview: z.string().nullish(),
  cwd: z.string().nullish(),
  model: z.string().nullish(),
  updatedAt: z.number().nullish(),
  recencyAt: z.number().nullish(),
  archivedAt: z.number().nullish(),
  status: z.looseObject({ type: z.string().optional(), activeFlags: z.array(z.string()).optional() }).nullish(),
});
type Thread = z.infer<typeof ThreadSchema>;
const ListSchema = z.looseObject({ data: z.array(ThreadSchema), nextCursor: z.string().nullish() });
const EntrySchema = z.looseObject({
  startedAtMs: z.number().nullish(),
  item: z.looseObject({ type: z.string(), text: z.string().optional(), content: z.unknown().optional() }),
});
const PageSchema = z.looseObject({ thread: ThreadSchema, data: z.array(z.unknown()) });
const CreatedSchema = z.looseObject({ thread: z.looseObject({ id: z.string() }) });
const BlocksSchema = z.array(z.looseObject({ type: z.string(), text: z.string().optional() }));
const WAITING = ["waitingOnApproval", "waitingOnUserInput"];
const TITLE_CHARS = 80;

/** A chat's state as the sidebar shows it: waiting for him counts before working. */
export function chatState(status: Thread["status"]): ChatState {
  if (status?.type === "systemError") return "failed";
  if (status?.type !== "active") return "idle";
  return status.activeFlags?.some(flag => WAITING.includes(flag)) ? "needs you" : "working";
}

/** Engine times are in seconds, desktop ones in milliseconds. */
const iso = (time: number | null | undefined): string | undefined =>
  time ? new Date(time < 1e12 ? time * 1000 : time).toISOString() : undefined;

function chat(thread: Thread): Chat {
  const first = (thread.preview ?? "").trim().split("\n")[0] ?? "";
  const updated = iso(thread.recencyAt ?? thread.updatedAt);
  return {
    id: thread.id,
    title: thread.name?.trim() || first.slice(0, TITLE_CHARS) || "Untitled chat",
    state: chatState(thread.status),
    ...(thread.cwd ? { folder: thread.cwd } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(updated ? { updated } : {}),
    ...(thread.archivedAt ? { archived: true } : {}),
  };
}

function message(raw: unknown): ChatMessage[] {
  const entry = EntrySchema.safeParse(raw);
  if (!entry.success) return [];
  const { item, startedAtMs } = entry.data;
  if (item.type !== "userMessage" && item.type !== "agentMessage") return [];
  const blocks = item.type === "userMessage" ? BlocksSchema.safeParse(item.content) : undefined;
  const text = blocks?.success
    ? blocks.data.flatMap(block => (block.type === "text" && block.text ? [block.text] : [])).join("\n")
    : (item.text ?? "");
  if (!text.trim()) return [];
  const at = iso(startedAtMs);
  return [{ from: item.type === "userMessage" ? "person" : "agent", text, ...(at ? { at } : {}) }];
}

/** The router's view of his chats, over the desktop client. */
export function createChats(client: ChatsClient): Chats {
  const read = async (id: string, limit: number) => {
    const page = PageSchema.parse(await client.readThread(id, { limit }));
    // The desktop pages a chat newest first; a reader wants it in the order it was said.
    return { chat: chat(page.thread), messages: page.data.flatMap(message).reverse() };
  };
  return {
    async list({ archived, search, limit, cursor }) {
      const page = { limit, ...(cursor ? { cursor } : {}) };
      const listed = ListSchema.parse(
        archived
          ? await client.listArchivedThreads(page)
          : await client.listThreads({ ...page, ...(search ? { searchTerm: search } : {}) }),
      );
      return {
        chats: listed.data.map(thread => ({ ...chat(thread), ...(archived ? { archived: true } : {}) })),
        ...(listed.nextCursor ? { next: listed.nextCursor } : {}),
      };
    },
    read,
    async send(id, text) {
      await client.send(id, { text });
    },
    async start({ text, name, folder, model, effort }) {
      const created = CreatedSchema.parse(
        await client.createThread({
          ...(folder ? { cwd: folder } : {}),
          ...(model ? { model } : {}),
          ...(name ? { name } : {}),
        }),
      );
      await client.send(created.thread.id, { text, ...(effort ? { effort } : {}) });
      return (await read(created.thread.id, 1)).chat;
    },
    async stop(id) {
      await client.interrupt(id, {});
    },
    async rename(id, name) {
      await client.renameThread(id, { name });
    },
    async archive(id) {
      await client.archiveThread(id, {});
    },
    async restore(id) {
      await client.unarchiveThread(id, {});
    },
  };
}
