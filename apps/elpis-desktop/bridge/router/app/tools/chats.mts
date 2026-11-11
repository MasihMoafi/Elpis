/**
 * Main Session tools over his chats, so he can talk to the router instead of watching tabs: see what is running and
 * what waits for him, read a chat, write in one, start, stop, rename, archive and restore. No tool deletes a chat.
 */
import { join } from "node:path";
import { z } from "zod";
import type { Chat, Chats } from "../../chats.mts";
import { tool, type Tool } from "./tool.mts";

export interface ChatToolsHost {
  readonly chats: Chats;
  /** A chat the router itself runs in (its own conversation, its own Sessions): it never acts on these. */
  own(chat: Pick<Chat, "id" | "folder">): boolean;
  /** Why the chat tools are off right now; nothing when they may run. */
  refusal(): string | undefined;
}

/**
 * The host of the chat tools. The router's own chats are off limits: its conversation with him and the Sessions that
 * run in its home folder. Every chat is off limits while a Source that carries outside text is on, so a comment on
 * GitHub can never write in one of his chats.
 */
export function chatToolsHost(
  chats: Chats,
  router: { home: string; threadId: string },
  settings: () => { sources: Record<string, { enabled: boolean } | undefined> },
): ChatToolsHost {
  const home = join(router.home, "router");
  return {
    chats,
    own: chat => chat.id === router.threadId || chat.folder === home,
    refusal: () =>
      Object.entries(settings().sources).some(([name, source]) => name !== "elpis-chat" && source?.enabled)
        ? "The chat tools are off while a Source that carries outside text is on, such as GitHub. He can turn it off in the router's settings."
        : undefined,
  };
}

const MESSAGE_CHARS = 2000;
/** How many chats one call may archive or restore. */
const BATCH = 50;
const ORDER: Record<Chat["state"], number> = { "needs you": 0, working: 1, failed: 2, idle: 3 };
const ChatId = z.string().min(1).describe("The chat's id, copied from chats_list.");

function allowed(host: ChatToolsHost): void {
  const refusal = host.refusal();
  if (refusal) throw new Error(refusal);
}

/** The chat to act on, refused when it is one of the router's own. */
async function target(host: ChatToolsHost, id: string): Promise<Chat> {
  allowed(host);
  const { chat } = await host.chats.read(id, 1);
  if (host.own(chat)) throw new Error("This is the router's own chat; it does not act on itself");
  return chat;
}

const clip = (text: string): string =>
  text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS)}… (${text.length - MESSAGE_CHARS} more characters)` : text;

function listTool(host: ChatToolsHost): Tool {
  return tool({
    name: "chats_list",
    description:
      "His chats in Elpis with their state: needs you (waits for his approval or answer), working, failed " +
      "or idle. Those that need him come first, then working ones, then the most recent. Use it to answer " +
      "what is running, what waits for him, or to find a chat's id by its title.",
    schema: z
      .object({
        show: z.enum(["open", "archived"]).default("open").describe("open: the sidebar's chats; archived: the archive."),
        search: z.string().trim().max(200).optional().describe("Words from the chat's title or first message."),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z
          .string()
          .min(1)
          .optional()
          .describe("next_cursor of the page before, to read the next one; the pages together hold every chat."),
      })
      .strict(),
    execute: async ({ show, search, limit, cursor }) => {
      allowed(host);
      const listed = await host.chats.list({ archived: show === "archived", search, limit, cursor });
      const chats = listed.chats
        .filter(chat => !host.own(chat))
        .sort((a, b) => ORDER[a.state] - ORDER[b.state] || (b.updated ?? "").localeCompare(a.updated ?? ""));
      const count = (state: Chat["state"]) => chats.filter(chat => chat.state === state).length;
      return {
        needs_you: count("needs you"),
        working: count("working"),
        failed: count("failed"),
        chats,
        ...(listed.next ? { next_cursor: listed.next } : {}),
      };
    },
  });
}

function readTool(host: ChatToolsHost): Tool {
  return tool({
    name: "chats_read",
    description:
      "The last messages of one chat, oldest first: what he asked and what the agent answered. Use it to " +
      "say what a chat concluded or what it is waiting for.",
    schema: z.object({ chat: ChatId, last: z.number().int().min(1).max(30).default(6) }).strict(),
    execute: async ({ chat, last }) => {
      allowed(host);
      const read = await host.chats.read(chat, last);
      return { chat: read.chat, messages: read.messages.map(message => ({ ...message, text: clip(message.text) })) };
    },
  });
}

function sendTool(host: ChatToolsHost): Tool {
  return tool({
    name: "chats_send",
    description:
      "Write a message in one of his chats, as he would: it starts that chat's next turn. Use it only when " +
      "he asks you to tell or ask a chat something; pass his request in his own words.",
    schema: z.object({ chat: ChatId, text: z.string().trim().min(1).max(8000) }).strict(),
    execute: async ({ chat, text }) => {
      const found = await target(host, chat);
      await host.chats.send(found.id, text);
      return { sent: true, chat: found.title };
    },
  });
}

function startTool(host: ChatToolsHost): Tool {
  return tool({
    name: "chats_start",
    description:
      "Start a new chat with a first message, when he asks for a new chat or a new agent. It runs on its " +
      "own; its result does not come back to you, so use orchestrator_route for work whose result he wants " +
      "here.",
    schema: z
      .object({
        text: z.string().trim().min(1).max(8000).describe("The first message, in his words."),
        name: z.string().trim().min(1).max(120).optional().describe("The chat's title."),
        folder: z.string().startsWith("/").optional().describe("The project folder to work in, as an absolute path."),
        model: z.string().trim().min(1).max(200).optional().describe("A model id he named; the default otherwise."),
        effort: z.string().trim().min(1).max(20).optional().describe("A thinking level he named."),
      })
      .strict(),
    execute: async input => {
      allowed(host);
      const chat = await host.chats.start(input);
      return { started: true, chat };
    },
  });
}

/**
 * Archives or restores several chats, each on its own: one the router may not touch, or one that fails, is named
 * with its reason and the others still go through.
 */
async function many(host: ChatToolsHost, ids: string[], action: "archive" | "restore") {
  const done: string[] = [];
  const refused: { chat: string; why: string }[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      const found = await target(host, id);
      if (action === "archive") await host.chats.archive(found.id);
      else await host.chats.restore(found.id);
      done.push(found.title);
    } catch (error) {
      refused.push({ chat: id, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { [action === "archive" ? "archived" : "restored"]: done.length, chats: done, refused };
}
function changeTool(host: ChatToolsHost): Tool {
  return tool({
    name: "chats_change",
    description:
      "Change one of his chats when he asks: stop its running turn, rename it, archive it (it leaves the " +
      "sidebar and can be restored) or restore it from the archive. To archive or restore many at once, as " +
      "when tidying, pass their ids in chats.",
    schema: z
      .object({
        chat: ChatId.optional(),
        chats: z
          .array(ChatId)
          .min(1)
          .max(BATCH)
          .optional()
          .describe(`Several chats at once, for archive and restore only, ${BATCH} at most.`),
        action: z.enum(["stop", "rename", "archive", "restore"]),
        name: z.string().trim().min(1).max(120).optional().describe("The new title, for rename."),
      })
      .strict(),
    execute: async ({ chat, chats, action, name }) => {
      if (chats) {
        if (chat) throw new Error("Give chat or chats, not both");
        if (action !== "archive" && action !== "restore") throw new Error(`${action} takes one chat at a time`);
        return many(host, chats, action);
      }
      if (!chat) throw new Error("Give chat, the chat's id");
      const found = await target(host, chat);
      if (action === "rename") {
        if (!name) throw new Error("rename needs name, the new title");
        await host.chats.rename(found.id, name);
        return { renamed: true, from: found.title, to: name };
      }
      if (action === "stop") await host.chats.stop(found.id);
      else if (action === "archive") await host.chats.archive(found.id);
      else await host.chats.restore(found.id);
      return { [action === "stop" ? "stopped" : action === "archive" ? "archived" : "restored"]: true, chat: found.title };
    },
  });
}

/** The chat tools of the main Session. */
export function chatTools(host: ChatToolsHost): Tool[] {
  return [listTool(host), readTool(host), sendTool(host), startTool(host), changeTool(host)];
}
