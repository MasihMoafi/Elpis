/**
 * Tells him in the Elpis chat when one of his chats finishes, fails or starts waiting for him, so he need not watch
 * tabs. The host does this itself, without a model: it looks at his chats every few seconds and says what changed.
 */
import { key } from "./core/index.mts";
import type { Chat, Chats } from "./chats.mts";

export interface WatchOptions {
  chats: Pick<Chats, "list" | "read">;
  /** Chats the router runs itself: its conversation, its Sessions and its workers, whose results it reports anyway. */
  skip(chat: Pick<Chat, "id" | "folder">): boolean;
  /** Writes one line in the Elpis chat; the id makes a repeated line a no-op. */
  say(id: string, text: string): Promise<unknown>;
}

const LIMIT = 50;
const LINE_CHARS = 160;

export class ChatWatch {
  private readonly options: WatchOptions;
  private seen: Map<string, Chat["state"]> | undefined;
  constructor(options: WatchOptions) {
    this.options = options;
  }
  /** One look at his chats: says what changed since the last look. The first look only remembers. */
  async look(): Promise<void> {
    const chats = (await this.options.chats.list({ limit: LIMIT })).filter(chat => !this.options.skip(chat));
    const before = this.seen;
    this.seen = new Map(chats.map(chat => [chat.id, chat.state]));
    if (!before) return;
    for (const chat of chats) {
      const was = before.get(chat.id);
      const text = await this.change(chat, was);
      if (text) await this.options.say(key("watch", chat.id, chat.state, chat.updated ?? ""), text);
    }
  }
  private async change(chat: Chat, was: Chat["state"] | undefined): Promise<string | undefined> {
    if (chat.state === "needs you")
      return was === "needs you" ? undefined : `Needs you: “${chat.title}” is waiting for your approval or answer.`;
    if (was !== "working") return undefined;
    if (chat.state === "failed") return `Failed: “${chat.title}” stopped with an error.`;
    if (chat.state !== "idle") return undefined;
    const last = await this.options.chats.read(chat.id, 1).then(
      read => read.messages.findLast(message => message.from === "agent")?.text ?? "",
      () => "",
    );
    const line = last.trim().split("\n")[0] ?? "";
    const said = line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS)}…` : line;
    return `Finished: “${chat.title}”.${said ? ` ${said}` : ""}`;
  }
}

/** Looks every `everyMs`; a look that fails is tried again at the next one. Returns the function that stops it. */
export function watchChats(options: WatchOptions, everyMs = 5000): () => void {
  const watch = new ChatWatch(options);
  let looking = false;
  const timer = setInterval(() => {
    if (looking) return;
    looking = true;
    void watch
      .look()
      .catch(() => {})
      .finally(() => {
        looking = false;
      });
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
